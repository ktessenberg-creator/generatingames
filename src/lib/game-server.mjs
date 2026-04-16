import { randomUUID } from "node:crypto";
import { summarizeDeck } from "./decks.mjs";
import {
  applyPendingEffectChoice,
  buildPendingEffectChoice,
  canPlayFromGraveyard,
  enqueueDeathTriggers,
  executeCardAbility,
  flushPendingEffects,
  isGoblinCard,
  listAvailableAbilities,
  listPlayableGraveyardCards
} from "./card-effects.mjs";

const OPENING_HAND_SIZE = 5;
const BOARD_SLOTS_PER_ZONE = 7;
const BOARD_ZONES = ["frontline", "flank", "backline"];
const ACTIONS_PER_TURN = 3;
const STARTING_LIFE_TOTAL = 20;

export class GameServer {
  constructor(decks) {
    this.decks = decks;
    this.deckIndex = new Map(decks.map((deck) => [deck.id, deck]));
    this.games = new Map();
  }

  listDecks() {
    return this.decks.map(summarizeDeck);
  }

  createGame() {
    const gameId = randomUUID();
    const hostPlayerId = randomUUID();
    const guestToken = randomUUID();
    const game = {
      id: gameId,
      status: "lobby",
      createdAt: new Date().toISOString(),
      hostPlayerId,
      guestToken,
      turnPlayerSeat: null,
      turnNumber: 0,
      winnerSeat: null,
      lastEvent: null,
      eventLog: [],
      lastLoggedEventKey: null,
      pendingAttack: null,
      pendingEffects: [],
      players: {
        one: createPlayer("one", hostPlayerId),
        two: createPlayer("two", null)
      }
    };

    this.games.set(gameId, game);
    return {
      gameId,
      hostPlayerId,
      guestToken
    };
  }

  createScriptedTestGame() {
    if (!this.decks.length) {
      throw createHttpError(400, "No decks are available for the test game.");
    }

    const primaryDeck = this.decks[0];
    const secondaryDeck = this.decks[1] || this.decks[0];
    const created = this.createGame();
    const joined = this.joinGame(created.gameId, created.guestToken);
    const game = this.requireGame(created.gameId);

    const playerOne = game.players.one;
    const playerTwo = game.players.two;
    playerOne.selectedDeckId = primaryDeck.id;
    playerOne.selectedDeckName = primaryDeck.name;
    playerTwo.selectedDeckId = secondaryDeck.id;
    playerTwo.selectedDeckName = secondaryDeck.name;

    seedTestPlayer(playerOne, primaryDeck, {
      lifeTotal: 16,
      actionsRemaining: 2,
      handCount: 4,
      frontline: [{ ready: true }, { ready: false }],
      flank: [{ ready: true }],
      backline: [{ ready: true }, { ready: false }]
    });
    seedTestPlayer(playerTwo, secondaryDeck, {
      lifeTotal: 12,
      actionsRemaining: 0,
      handCount: 4,
      frontline: [{ ready: true }, { ready: true }],
      flank: [{ ready: false }],
      backline: [{ ready: true }, { ready: true }]
    });

    game.status = "active";
    game.turnPlayerSeat = "one";
    game.turnNumber = 5;
    game.winnerSeat = null;
    game.pendingAttack = null;
    game.pendingEffects = [];
    game.lastEvent = {
      type: "test",
      attackerSeat: "one",
      summary: "Scripted test board is ready for combat and movement checks."
    };

    return {
      gameId: game.id,
      hostPlayerId: created.hostPlayerId,
      guestPlayerId: joined.playerId
    };
  }

  joinGame(gameId, guestToken) {
    const game = this.requireGame(gameId);
    if (game.guestToken !== guestToken) {
      throw createHttpError(403, "Join token is invalid.");
    }
    if (game.players.two.id) {
      return { playerId: game.players.two.id, gameId };
    }

    game.players.two.id = randomUUID();
    return { playerId: game.players.two.id, gameId };
  }

  chooseDeck(gameId, playerId, deckId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    const deck = this.deckIndex.get(deckId);

    if (!deck) {
      throw createHttpError(400, "Deck not found.");
    }
    if (game.status !== "lobby") {
      throw createHttpError(400, "You can only choose decks in the lobby.");
    }

    player.selectedDeckId = deckId;
    player.selectedDeckName = deck.name;
    return this.buildView(game, player.seat);
  }

  startGame(gameId, playerId) {
    const game = this.requireGame(gameId);
    this.requirePlayer(game, playerId);

    if (game.status !== "lobby") {
      throw createHttpError(400, "Game has already started.");
    }
    if (!game.players.one.id || !game.players.two.id) {
      throw createHttpError(400, "Both players must join before the game starts.");
    }
    if (!game.players.one.selectedDeckId || !game.players.two.selectedDeckId) {
      throw createHttpError(400, "Both players must choose decks before the game starts.");
    }

    for (const seat of ["one", "two"]) {
      const player = game.players[seat];
      const deck = this.deckIndex.get(player.selectedDeckId);
      player.deck = shuffle(deck.cards.map((card) => materializeCard(card)));
      player.hand = player.deck.splice(0, OPENING_HAND_SIZE);
      player.board = createEmptyBoard();
      player.discard = [];
      player.actionsRemaining = 0;
      player.lifeTotal = STARTING_LIFE_TOTAL;
    }

    game.status = "active";
    game.winnerSeat = null;
    game.lastEvent = null;
    game.pendingAttack = null;
    game.pendingEffects = [];
    beginTurn(game, "one", { skipDraw: true });
    return this.buildView(game, this.requirePlayer(game, playerId).seat);
  }

  playCard(gameId, playerId, instanceId, zone) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    assertZoneKey(zone);
    if (player.board[zone].length >= BOARD_SLOTS_PER_ZONE) {
      throw createHttpError(400, "That zone is full.");
    }

    const cardIndex = player.hand.findIndex((card) => card.instanceId === instanceId);
    if (cardIndex === -1) {
      throw createHttpError(404, "Card not found in hand.");
    }

    const [card] = player.hand.splice(cardIndex, 1);
    spendAction(player, getCardPlayCost(card));
    player.board[zone].push({ ...materializeCard(card), zone, ready: zone === "backline" });
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: `${card.name} entered the ${zone}.`
    };
    return this.buildView(game, player.seat);
  }

  drawCard(gameId, playerId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    spendAction(player, 1);
    const drawn = drawCards(player, 1);
    game.lastEvent = {
      type: "draw",
      attackerSeat: player.seat,
      summary: `${player.selectedDeckName || "Player"} drew ${drawn[0]?.name || "a card"}.`
    };
    return this.buildView(game, player.seat);
  }

  moveBoardCard(gameId, playerId, instanceId, toZone) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    assertZoneKey(toZone);
    if (player.board[toZone].length >= BOARD_SLOTS_PER_ZONE) {
      throw createHttpError(400, "That zone is full.");
    }

    for (const zone of BOARD_ZONES) {
      const cardIndex = player.board[zone].findIndex((card) => card.instanceId === instanceId);
      if (cardIndex === -1) {
        continue;
      }

      spendAction(player, 1);
      const [card] = player.board[zone].splice(cardIndex, 1);
      player.board[toZone].push({ ...card, zone: toZone });
      game.lastEvent = {
        type: "move",
        attackerSeat: player.seat,
        summary: `${card.name} moved from ${zone} to ${toZone}.`
      };
      return this.buildView(game, player.seat);
    }

    throw createHttpError(404, "Card not found on board.");
  }

  playFromGraveyard(gameId, playerId, instanceId, zone) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    assertZoneKey(zone);
    if (player.board[zone].length >= BOARD_SLOTS_PER_ZONE) {
      throw createHttpError(400, "That zone is full.");
    }

    const discardIndex = player.discard.findIndex((card) => card.instanceId === instanceId);
    if (discardIndex === -1) {
      throw createHttpError(404, "Card not found in graveyard.");
    }

    const card = player.discard[discardIndex];
    if (!canPlayFromGraveyard(player, card, BOARD_ZONES)) {
      throw createHttpError(400, "That graveyard play is not currently available.");
    }

    const canPlayFreeSharedOneDrop =
      Number(card.basePower ?? card.power ?? 0) === 1 &&
      !player.graveyardFreePlayUsed &&
      player.board.frontline.concat(player.board.flank, player.board.backline).some(
        (boardCard) => boardCard.name === "Abaddon, Goblin King" && (boardCard.factions || []).some((faction) => (card.factions || []).includes(faction))
      );

    if (canPlayFreeSharedOneDrop) {
      player.graveyardFreePlayUsed = true;
    } else {
      spendAction(player, getCardPlayCost(card));
    }

    const [played] = player.discard.splice(discardIndex, 1);
    player.board[zone].push({ ...materializeCard(played), zone, ready: zone === "backline" });
    game.lastEvent = {
      type: "graveyard-play",
      attackerSeat: player.seat,
      summary: `${played.name} rose from the graveyard into the ${zone}.`
    };
    return this.buildView(game, player.seat);
  }

  useCardAbility(gameId, playerId, sourceId, payload = {}) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    const sourceEntry = findBoardCard(player.board, sourceId);
    if (!sourceEntry) {
      throw createHttpError(404, "Source card not found on board.");
    }

    executeCardAbility({
      game,
      player,
      sourceEntry,
      payload,
      helpers: {
        spendAction,
        destroyControlledGoblin,
        findBoardCard,
        countGoblinCards,
        createHttpError
      }
    });
    return this.buildView(game, player.seat);
  }

  resolvePendingEffect(gameId, playerId, choiceId = null) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    const effect = game.pendingEffects[0];
    if (!effect) {
      throw createHttpError(400, "There is no pending effect to resolve.");
    }
    if (effect.controllerSeat !== player.seat) {
      throw createHttpError(403, "Only the controlling player can resolve this effect.");
    }

    applyPendingEffectChoice(game, effect, choiceId, {
      createHttpError,
      shiftBoardCard
    });
    game.pendingEffects.shift();
    flushPendingEffects(game, {
      summonGoblinToken,
      millCards
    });
    return this.buildView(game, player.seat);
  }

  attack(gameId, playerId, payload) {
    const game = this.requireGame(gameId);
    const attackerPlayer = this.requirePlayer(game, playerId);
    this.assertActiveTurn(game, attackerPlayer);

    const defenderSeat = attackerPlayer.seat === "one" ? "two" : "one";
    const defenderPlayer = game.players[defenderSeat];
    const attackerEntry = findBoardCard(attackerPlayer.board, payload.attackerId);
    if (!attackerEntry) {
      throw createHttpError(404, "Attacker not found on board.");
    }
    if (!["frontline", "flank"].includes(attackerEntry.zone)) {
      throw createHttpError(400, "Only frontline and flank units can attack.");
    }
    if (!attackerEntry.card.ready) {
      throw createHttpError(400, "That unit is not ready.");
    }

    const target = normalizeAttackTarget(payload.target);
    const defenderEntry = target.type === "unit" ? findBoardCard(defenderPlayer.board, target.instanceId) : null;
    if (target.type === "unit" && !defenderEntry) {
      throw createHttpError(404, "Defender not found on board.");
    }

    assertAttackTarget(attackerPlayer, attackerEntry, defenderEntry, target, defenderPlayer.board);

    const attackingReinforcer = payload.attackingReinforcerId
      ? requireBacklineReinforcer(attackerPlayer.board, payload.attackingReinforcerId, "Attacking")
      : null;
    if (attackingReinforcer && attackerEntry.zone !== "frontline") {
      throw createHttpError(400, "Only frontline attackers can be reinforced.");
    }

    spendAction(attackerPlayer, 1);
    attackerEntry.card.ready = false;
    if (attackingReinforcer) {
      attackingReinforcer.card.ready = false;
    }

    if (target.type === "direct") {
      resolveAttack(game, {
        attackerSeat: attackerPlayer.seat,
        defenderSeat,
        attackerId: attackerEntry.instanceId,
        attackingReinforcerId: attackingReinforcer?.instanceId || null,
        target
      });
      return this.buildView(game, attackerPlayer.seat);
    }

    const defenseChoices = defenderEntry.zone === "frontline" ? listReadyBacklineReinforcers(defenderPlayer.board) : [];
    if (defenseChoices.length) {
      game.pendingAttack = {
        attackerSeat: attackerPlayer.seat,
        defenderSeat,
        attackerId: attackerEntry.instanceId,
        attackingReinforcerId: attackingReinforcer?.instanceId || null,
        target,
        declaredAt: new Date().toISOString()
      };
      game.lastEvent = {
        type: "attack",
        attackerSeat: attackerPlayer.seat,
        summary: `${attackerEntry.card.name} attacks ${defenderEntry.card.name}. Waiting for defender reinforcement.`
      };
      return this.buildView(game, attackerPlayer.seat);
    }

    resolveAttack(game, {
      attackerSeat: attackerPlayer.seat,
      defenderSeat,
      attackerId: attackerEntry.instanceId,
      attackingReinforcerId: attackingReinforcer?.instanceId || null,
      target
    });

    return this.buildView(game, attackerPlayer.seat);
  }

  respondToPendingAttack(gameId, playerId, defendingReinforcerId = null) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    const pendingAttack = game.pendingAttack;

    if (!pendingAttack) {
      throw createHttpError(400, "There is no pending attack to respond to.");
    }
    if (player.seat !== pendingAttack.defenderSeat) {
      throw createHttpError(403, "Only the defending player can choose the defender reinforcer.");
    }

    if (defendingReinforcerId) {
      const defenderPlayer = game.players[pendingAttack.defenderSeat];
      const defenderEntry = pendingAttack.target.type === "unit" ? findBoardCard(defenderPlayer.board, pendingAttack.target.instanceId) : null;
      if (!defenderEntry || defenderEntry.zone !== "frontline") {
        throw createHttpError(400, "Only an attacked frontline defender can be reinforced.");
      }
      requireBacklineReinforcer(defenderPlayer.board, defendingReinforcerId, "Defending");
    }

    resolveAttack(game, { ...pendingAttack, defendingReinforcerId });
    return this.buildView(game, player.seat);
  }

  endTurn(gameId, playerId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    const nextSeat = player.seat === "one" ? "two" : "one";
    beginTurn(game, nextSeat, { skipDraw: false });
    return this.buildView(game, player.seat);
  }

  getView(gameId, playerId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    return this.buildView(game, player.seat);
  }

  requireGame(gameId) {
    const game = this.games.get(gameId);
    if (!game) {
      throw createHttpError(404, "Game not found.");
    }
    return game;
  }

  requirePlayer(game, playerId) {
    for (const seat of ["one", "two"]) {
      if (game.players[seat].id === playerId) {
        return game.players[seat];
      }
    }
    throw createHttpError(403, "Player is not part of this game.");
  }

  assertActiveTurn(game, player) {
    if (game.status !== "active") {
      throw createHttpError(400, game.status === "completed" ? "The game is already over." : "Game is not active.");
    }
    if (game.pendingAttack) {
      throw createHttpError(400, "A combat response is pending.");
    }
    if (game.pendingEffects.length) {
      throw createHttpError(400, "A triggered effect is waiting to resolve.");
    }
    if (game.turnPlayerSeat !== player.seat) {
      throw createHttpError(400, "It is not your turn.");
    }
  }

  buildView(game, viewerSeat) {
    syncEventLog(game);
    const viewer = game.players[viewerSeat];
    const opponentSeat = viewerSeat === "one" ? "two" : "one";
    const opponent = game.players[opponentSeat];

    return {
      gameId: game.id,
      status: game.status,
      viewerSeat,
      canStart:
        game.status === "lobby" &&
        Boolean(game.players.one.id && game.players.two.id && game.players.one.selectedDeckId && game.players.two.selectedDeckId),
      turnPlayerSeat: game.turnPlayerSeat,
      turnNumber: game.turnNumber,
      winnerSeat: game.winnerSeat,
      inviteToken: viewerSeat === "one" ? game.guestToken : null,
      lastEvent: game.lastEvent,
      eventLog: game.eventLog,
      pendingDefenseChoice: buildPendingDefenseChoice(game, viewerSeat),
      pendingEffectChoice: buildPendingEffectChoice(game, viewerSeat),
      players: {
        self: serializeSelf(viewer),
        opponent: serializeOpponent(opponent)
      }
    };
  }
}

function createPlayer(seat, id) {
  return {
    seat,
    id,
    selectedDeckId: null,
    selectedDeckName: null,
    deck: [],
    hand: [],
    board: createEmptyBoard(),
    discard: [],
    actionsRemaining: 0,
    lifeTotal: STARTING_LIFE_TOTAL,
    tempCardPower: {},
    tempGoblinPower: 0,
    directAttackIds: [],
    graveyardFreePlayUsed: false,
    supportActionsTakenThisTurn: 0,
    freeSupportActionsRemaining: 0,
    pendingEffects: []
  };
}

function syncEventLog(game) {
  if (!game.lastEvent) {
    return;
  }

  const key = JSON.stringify({
    turn: game.turnNumber,
    type: game.lastEvent.type,
    seat: game.lastEvent.attackerSeat,
    summary: game.lastEvent.summary
  });

  if (game.lastLoggedEventKey === key) {
    return;
  }

  game.eventLog = [
    {
      turnNumber: game.turnNumber,
      ...game.lastEvent
    },
    ...(game.eventLog || [])
  ].slice(0, 12);
  game.lastLoggedEventKey = key;
}

function createEmptyBoard() {
  return {
    frontline: [],
    flank: [],
    backline: []
  };
}

function serializeSelf(player) {
  return {
    id: player.id,
    seat: player.seat,
    deckId: player.selectedDeckId,
    deckName: player.selectedDeckName,
    deckCount: player.deck.length,
    handCount: player.hand.length,
    boardCount: countBoardCards(player.board),
    actionsRemaining: player.actionsRemaining,
    lifeTotal: player.lifeTotal,
    hand: player.hand.map((card) => serializeCard(player, card)),
    board: serializeBoard(player),
    discard: player.discard.map((card) => serializeCard(player, card)),
    discardCount: player.discard.length,
    supportActionsTakenThisTurn: player.supportActionsTakenThisTurn,
    availableAbilities: listAvailableAbilities(player, BOARD_ZONES),
    playableGraveyard: listPlayableGraveyardCards(player, BOARD_ZONES)
  };
}

function serializeOpponent(player) {
  return {
    id: player.id,
    seat: player.seat,
    deckId: player.selectedDeckId,
    deckName: player.selectedDeckName,
    deckCount: player.deck.length,
    handCount: player.hand.length,
    boardCount: countBoardCards(player.board),
    actionsRemaining: player.actionsRemaining,
    lifeTotal: player.lifeTotal,
    board: serializeBoard(player),
    discard: player.discard.map((card) => serializeCard(player, card)),
    discardCount: player.discard.length
  };
}

function beginTurn(game, seat, { skipDraw }) {
  game.turnPlayerSeat = seat;
  game.turnNumber += 1;

  for (const player of Object.values(game.players)) {
    player.actionsRemaining = player.seat === seat ? ACTIONS_PER_TURN : 0;
    player.tempCardPower = {};
    player.tempGoblinPower = 0;
    player.directAttackIds = [];
    player.graveyardFreePlayUsed = false;
    player.supportActionsTakenThisTurn = 0;
    player.freeSupportActionsRemaining = 0;
  }

  readyBoard(game.players[seat].board);

  if (!skipDraw) {
    drawCards(game.players[seat], 1, { silentIfEmpty: true });
  }

  game.lastEvent = {
    type: "turn",
    attackerSeat: seat,
    summary: `${game.players[seat].selectedDeckName || "Player"} begins turn ${game.turnNumber}.`
  };
}

function readyBoard(board) {
  for (const zone of BOARD_ZONES) {
    for (const card of board[zone]) {
      card.ready = true;
    }
  }
}

function drawCards(player, count, options = {}) {
  if (player.deck.length < count) {
    if (options.silentIfEmpty) {
      return [];
    }
    throw createHttpError(400, "Your deck is empty.");
  }

  const drawn = player.deck.splice(0, count);
  player.hand.push(...drawn);
  return drawn;
}

function spendAction(player, amount) {
  if (player.actionsRemaining < amount) {
    throw createHttpError(400, "You do not have enough actions remaining.");
  }
  player.actionsRemaining -= amount;
}

function getCardPlayCost(card) {
  const arcana = String(card.arcana ?? "").trim().toLowerCase();
  if (arcana === "major") {
    return 2;
  }
  if (arcana === "chaff") {
    return 0;
  }
  return 1;
}

function countBoardCards(board) {
  return BOARD_ZONES.reduce((total, zone) => total + board[zone].length, 0);
}

function serializeBoard(player) {
  return Object.fromEntries(
    BOARD_ZONES.map((zone) => [zone, player.board[zone].map((card) => serializeCard(player, card))])
  );
}

function serializeCard(player, card) {
  return {
    ...card,
    basePower: card.basePower ?? card.power ?? 0,
    power: getCardPower(player, card)
  };
}

function getCardPower(player, card) {
  const basePower = Number(card.basePower ?? card.power ?? 0);
  const perCard = Number(player.tempCardPower?.[card.instanceId] ?? 0);
  const goblinBonus = isGoblinCard(card) ? Number(player.tempGoblinPower ?? 0) : 0;
  return basePower + perCard + goblinBonus;
}

function listReadyBacklineReinforcers(board) {
  return (board.backline || [])
    .filter((card) => card.ready)
    .map((card) => ({ id: card.instanceId, name: card.name, power: card.basePower ?? card.power }));
}

function normalizeAttackTarget(target) {
  if (!target || typeof target !== "object") {
    throw createHttpError(400, "Attack target is required.");
  }
  if (target.type === "direct") {
    return { type: "direct" };
  }
  if (target.type === "unit" && target.instanceId) {
    return { type: "unit", instanceId: target.instanceId };
  }
  throw createHttpError(400, "Attack target is invalid.");
}

function assertAttackTarget(attackerPlayer, attackerEntry, defenderEntry, target, defenderBoard) {
  const frontlineEmpty = defenderBoard.frontline.length === 0;

  if (attackerEntry.zone === "flank") {
    if (target.type === "direct" && !frontlineEmpty && !attackerHasDirectPermission(attackerPlayer, attackerEntry.instanceId)) {
      throw createHttpError(400, "Flank units can only attack directly when the opposing frontline is empty.");
    }
    if (target.type === "unit" && !["frontline", "flank", "backline"].includes(defenderEntry.zone)) {
      throw createHttpError(400, "Flank attack target is invalid.");
    }
    return;
  }

  if (attackerEntry.zone === "frontline") {
    if (target.type === "unit" && defenderEntry.zone === "frontline") {
      return;
    }
    if (target.type === "direct" && attackerHasDirectPermission(attackerPlayer, attackerEntry.instanceId)) {
      return;
    }
    if (!frontlineEmpty) {
      throw createHttpError(400, "Frontline units must attack the opposing frontline while it exists.");
    }
    if (target.type === "direct") {
      return;
    }
    if (!["backline", "flank"].includes(defenderEntry.zone)) {
      throw createHttpError(400, "Frontline attack target is invalid.");
    }
    return;
  }

  throw createHttpError(400, "That unit cannot attack from its current zone.");
}

function attackerHasDirectPermission(player, instanceId) {
  return player.directAttackIds.includes(instanceId);
}

function requireBacklineReinforcer(board, instanceId, label) {
  const entry = findBoardCard(board, instanceId);
  if (!entry || entry.zone !== "backline") {
    throw createHttpError(400, `${label} reinforcer must come from the backline.`);
  }
  if (!entry.card.ready) {
    throw createHttpError(400, `${label} reinforcer is not ready.`);
  }
  return entry;
}

function requireDeclaredBacklineReinforcer(board, instanceId, label) {
  const entry = findBoardCard(board, instanceId);
  if (!entry || entry.zone !== "backline") {
    throw createHttpError(400, `${label} reinforcer must come from the backline.`);
  }
  return entry;
}

function findBoardCard(board, instanceId) {
  for (const zone of BOARD_ZONES) {
    const card = board[zone].find((candidate) => candidate.instanceId === instanceId);
    if (card) {
      return { card, zone, instanceId };
    }
  }
  return null;
}

function removeBoardCard(player, instanceId) {
  for (const zone of BOARD_ZONES) {
    const index = player.board[zone].findIndex((candidate) => candidate.instanceId === instanceId);
    if (index !== -1) {
      const [card] = player.board[zone].splice(index, 1);
      player.discard.push(card);
      return card;
    }
  }
  return null;
}

function destroyBoardCard(game, ownerSeat, instanceId, sourceName = "") {
  const player = game.players[ownerSeat];
  const opponentSeat = ownerSeat === "one" ? "two" : "one";
  const destroyed = removeBoardCard(player, instanceId);
  if (!destroyed) {
    throw createHttpError(404, "Card to destroy was not found on board.");
  }

  enqueueDeathTriggers(game, ownerSeat, opponentSeat, destroyed, {
    collectGoblinTargets,
    collectShiftChoices
  });
  flushPendingEffects(game, {
    summonGoblinToken,
    millCards
  });
  return destroyed;
}

function resolveAttack(game, payload) {
  const attackerPlayer = game.players[payload.attackerSeat];
  const defenderPlayer = game.players[payload.defenderSeat];
  const attackerEntry = findBoardCard(attackerPlayer.board, payload.attackerId);
  if (!attackerEntry) {
    throw createHttpError(404, "Attacker not found on board.");
  }

  const attackingReinforcer = payload.attackingReinforcerId
    ? requireDeclaredBacklineReinforcer(attackerPlayer.board, payload.attackingReinforcerId, "Attacking")
    : null;
  const defenderEntry = payload.target.type === "unit" ? findBoardCard(defenderPlayer.board, payload.target.instanceId) : null;
  const defendingReinforcer = payload.defendingReinforcerId
    ? requireBacklineReinforcer(defenderPlayer.board, payload.defendingReinforcerId, "Defending")
    : null;

  if (defendingReinforcer) {
    defendingReinforcer.card.ready = false;
  }

  const attackPower = getCardPower(attackerPlayer, attackerEntry.card) + Number(attackingReinforcer ? getCardPower(attackerPlayer, attackingReinforcer.card) : 0);
  const defensePower = Number(defenderEntry ? getCardPower(defenderPlayer, defenderEntry.card) : 0) + Number(defendingReinforcer ? getCardPower(defenderPlayer, defendingReinforcer.card) : 0);

  if (payload.target.type === "direct") {
    defenderPlayer.lifeTotal -= attackPower;
    if (defenderPlayer.lifeTotal <= 0) {
      game.status = "completed";
      game.winnerSeat = attackerPlayer.seat;
      game.turnPlayerSeat = null;
      attackerPlayer.actionsRemaining = 0;
      defenderPlayer.actionsRemaining = 0;
    }

    game.pendingAttack = null;
    game.lastEvent = {
      type: "attack",
      attackerSeat: attackerPlayer.seat,
      summary: `${attackerEntry.card.name} hit directly for ${attackPower}.`
    };
    return;
  }

  const defeated = [];
  const attackerDies = attackerEntry.zone === "flank" ? defensePower >= attackPower : defensePower > attackPower;
  const defenderDies = attackerEntry.zone === "flank" ? attackPower >= defensePower : attackPower > defensePower;

  if (defenderDies) {
    defeated.push(destroyBoardCard(game, payload.defenderSeat, defenderEntry.instanceId, attackerEntry.card.name));
  }
  if (attackerDies) {
    defeated.push(destroyBoardCard(game, payload.attackerSeat, attackerEntry.instanceId, defenderEntry.card.name));
  }

  game.pendingAttack = null;
  game.lastEvent = {
    type: "attack",
    attackerSeat: attackerPlayer.seat,
    summary: buildAttackSummary({
      attacker: attackerEntry.card.name,
      defender: defenderEntry.card.name,
      attackPower,
      defensePower,
      defeated
    })
  };
}

function buildPendingDefenseChoice(game, viewerSeat) {
  const pendingAttack = game.pendingAttack;
  if (!pendingAttack || pendingAttack.defenderSeat !== viewerSeat) {
    return null;
  }

  const defenderPlayer = game.players[pendingAttack.defenderSeat];
  const attackerPlayer = game.players[pendingAttack.attackerSeat];
  const attackerEntry = findBoardCard(attackerPlayer.board, pendingAttack.attackerId);
  const attackingReinforcer = pendingAttack.attackingReinforcerId
    ? findBoardCard(attackerPlayer.board, pendingAttack.attackingReinforcerId)
    : null;
  const defenderEntry =
    pendingAttack.target.type === "unit" ? findBoardCard(defenderPlayer.board, pendingAttack.target.instanceId) : null;
  if (!attackerEntry || !defenderEntry) {
    return null;
  }

  return {
    attackerName: attackerEntry.card.name,
    defenderName: defenderEntry.card.name,
    defenderId: defenderEntry.instanceId,
    attacker: serializeCombatCard(attackerPlayer, attackerEntry),
    attackingReinforcer: attackingReinforcer ? serializeCombatCard(attackerPlayer, attackingReinforcer) : null,
    defender: serializeCombatCard(defenderPlayer, defenderEntry),
    choices: listReadyBacklineReinforcersDetailed(defenderPlayer)
  };
}

function serializeCombatCard(player, entry) {
  return {
    id: entry.instanceId,
    name: entry.card.name,
    zone: entry.zone,
    power: getCardPower(player, entry.card),
    portraitPath: entry.card.portraitPath || entry.card.cardAssetPath,
    cardAssetPath: entry.card.cardAssetPath
  };
}

function listReadyBacklineReinforcersDetailed(player) {
  return (player.board.backline || [])
    .filter((card) => card.ready)
    .map((card) => ({
      id: card.instanceId,
      name: card.name,
      power: getCardPower(player, card),
      portraitPath: card.portraitPath || card.cardAssetPath,
      cardAssetPath: card.cardAssetPath,
      zone: "backline"
    }));
}

function buildAttackSummary({ attacker, defender, attackPower, defensePower, defeated }) {
  const defeatedNames = defeated.filter(Boolean).map((card) => card.name);
  const defeatText = defeatedNames.length ? ` ${defeatedNames.join(" and ")} fell.` : " Nobody died.";
  return `${attacker} attacked ${defender} at ${attackPower} vs ${defensePower}.${defeatText}`;
}

function assertZoneKey(zone) {
  if (!BOARD_ZONES.includes(zone)) {
    throw createHttpError(400, "Zone is invalid.");
  }
}

function destroyControlledGoblin(game, seat, targetId, sourceName) {
  const player = game.players[seat];
  const target = findBoardCard(player.board, targetId);
  if (!target || !isGoblinCard(target.card)) {
    throw createHttpError(400, `${sourceName} must destroy a Goblin you control.`);
  }
  return destroyBoardCard(game, seat, targetId, sourceName);
}

function countGoblinCards(cards) {
  return cards.filter((card) => isGoblinCard(card)).length;
}

function collectGoblinTargets(board, excludeId) {
  return BOARD_ZONES.flatMap((zone) =>
    board[zone]
      .filter((card) => card.instanceId !== excludeId && isGoblinCard(card))
      .map((card) => ({ id: card.instanceId, label: card.name, detail: zone }))
  );
}

function collectShiftChoices(board) {
  return BOARD_ZONES.flatMap((zone) =>
    board[zone].flatMap((card) =>
      BOARD_ZONES.filter((toZone) => toZone !== zone && board[toZone].length < BOARD_SLOTS_PER_ZONE).map((toZone) => ({
        id: `${card.instanceId}:${toZone}`,
        targetId: card.instanceId,
        toZone,
        label: card.name,
        detail: `${zone} -> ${toZone}`
      }))
    )
  );
}

function shiftBoardCard(player, instanceId, toZone) {
  for (const zone of BOARD_ZONES) {
    const index = player.board[zone].findIndex((card) => card.instanceId === instanceId);
    if (index !== -1) {
      const [card] = player.board[zone].splice(index, 1);
      player.board[toZone].push({ ...card, zone: toZone });
      return;
    }
  }
}

function summonGoblinToken(player) {
  const token = materializeCard({
    instanceId: `goblin-token:${randomUUID().slice(0, 8)}`,
    cardId: "goblin-token",
    name: "Goblin Token",
    faction: "Goblins",
    factions: ["Goblins"],
    cardType: "Goblin",
    arcana: "Chaff",
    basePower: 1,
    power: 1,
    text: "",
    flavourText: "",
    portraitPath: "",
    cardAssetPath: "/output/cards/goblin.svg"
  });

  for (const zone of ["frontline", "flank", "backline"]) {
    if (player.board[zone].length < BOARD_SLOTS_PER_ZONE) {
      player.board[zone].push({ ...token, zone, ready: zone === "backline" });
      return;
    }
  }
}

function millCards(player, count) {
  const milled = player.deck.splice(0, count);
  player.discard.push(...milled);
}

function materializeCard(card) {
  return {
    ...card,
    basePower: Number(card.basePower ?? card.power ?? 0),
    power: Number(card.basePower ?? card.power ?? 0)
  };
}

function seedTestPlayer(player, deck, config) {
  const cards = deck.cards.map((card, index) => cloneDeckCard(card, `${player.seat}-${index + 1}`));
  let cursor = 0;
  const take = (count) => {
    const slice = cards.slice(cursor, cursor + count);
    cursor += count;
    return slice;
  };
  const takeOne = () => {
    const [card] = take(1);
    if (!card) {
      throw createHttpError(500, `Deck ${deck.name} does not have enough cards for the scripted test game.`);
    }
    return card;
  };

  player.board = createEmptyBoard();
  for (const setup of config.frontline) {
    player.board.frontline.push({ ...materializeCard(takeOne()), zone: "frontline", ready: setup.ready });
  }
  for (const setup of config.flank) {
    player.board.flank.push({ ...materializeCard(takeOne()), zone: "flank", ready: setup.ready });
  }
  for (const setup of config.backline) {
    player.board.backline.push({ ...materializeCard(takeOne()), zone: "backline", ready: setup.ready });
  }

  player.hand = take(config.handCount).map(materializeCard);
  player.deck = cards.slice(cursor).map(materializeCard);
  player.discard = [];
  player.actionsRemaining = config.actionsRemaining;
  player.lifeTotal = config.lifeTotal;
}

function cloneDeckCard(card, suffix) {
  return {
    ...card,
    instanceId: `${card.instanceId}:${suffix}:${randomUUID().slice(0, 8)}`
  };
}

function shuffle(cards) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
