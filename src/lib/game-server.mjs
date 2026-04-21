import { randomUUID } from "node:crypto";
import { summarizeDeck } from "./decks.mjs";
import {
  applyPendingEffectChoice,
  buildPendingEffectChoice,
  canPlayFromGraveyard,
  enqueueDeathTriggers,
  executeCardAbility,
  flushPendingEffects,
  handleCardPlayed,
  isGoblinCard,
  listAvailableAbilities,
  listPlayableGraveyardCards,
  countCardsInPlayForEffects
} from "./card-effects.mjs";

const OPENING_HAND_SIZE = 5;
const BOARD_SLOTS_PER_ZONE = 7;
const BOARD_ZONES = ["frontline", "flank", "backline"];
const OPENING_PLAYER_ACTIONS = 3;
const ACTIONS_PER_TURN = 4;
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
    const card = player.hand[cardIndex];
    const playedCard = playHandCardToBoard(player, instanceId, zone, { payCardCost: true });
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: `${card.name} entered the ${zone}.`
    };
    handleCardPlayed(game, player, playedCard, {
      summonAdventurerToken,
      drawCards,
      moveDiscardToHand,
      destroyBoardCard,
      shiftBoardCard
    });
    flushPendingEffects(game, {
      summonGoblinToken,
      millCards
    });
    return this.buildView(game, player.seat);
  }

  flipCardFaceUp(gameId, playerId, instanceId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    this.assertActiveTurn(game, player);
    const entry = findBoardCard(player.board, instanceId);
    if (!entry) {
      throw createHttpError(404, "Card not found on board.");
    }
    if (!entry.card.faceDown) {
      throw createHttpError(400, "That card is already face up.");
    }

    entry.card.faceDown = false;
    game.lastEvent = {
      type: "flip",
      attackerSeat: player.seat,
      summary: `${entry.card.name} was flipped face up.`
    };
    return this.buildView(game, player.seat);
  }

  drawCard(gameId, playerId) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);

    this.assertActiveTurn(game, player);
    if (player.blockedDrawActionTurn === game.turnNumber) {
      throw createHttpError(400, "You may not take the draw action this turn.");
    }
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

      assertCardCanTakeActions(player.board[zone][cardIndex], game, player);
      assertCardCanUseMoveAction(player.board[zone][cardIndex]);
      spendAction(player, 1);
      const [card] = player.board[zone].splice(cardIndex, 1);
      if (card.faceDown) {
        card.faceDown = false;
      }
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
    assertCardCanEnterZone(card, zone);
    if (card.name === "Death" && zone !== "backline") {
      throw createHttpError(400, "Death may only be played in the backline.");
    }
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
    const playedCard = { ...materializeCard(played), zone, ready: zone === "backline" };
    player.board[zone].push(playedCard);
    game.lastEvent = {
      type: "graveyard-play",
      attackerSeat: player.seat,
      summary: `${played.name} rose from the graveyard into the ${zone}.`
    };
    handleCardPlayed(game, player, playedCard, {
      summonAdventurerToken,
      drawCards,
      moveDiscardToHand,
      destroyBoardCard,
      shiftBoardCard
    });
    flushPendingEffects(game, {
      summonGoblinToken,
      millCards
    });
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
    if (sourceEntry.card.faceDown) {
      throw createHttpError(400, "Facedown cards must be flipped face up before using abilities.");
    }
    assertCardCanTakeActions(sourceEntry.card, game, player);

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
        createHttpError,
        shiftBoardCard,
        millCards,
        drawCards,
        moveDiscardToHand,
        setCardActionLock,
        playHandCardToBoard,
        findHandCard
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
      shiftBoardCard,
      millCards,
      stealBoardCard,
      resolveJerrisForcedAttack,
      moveDiscardToHand,
      destroyBoardCard
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
    assertCardCanTakeActions(attackerEntry.card, game, attackerPlayer);
    if (!attackerEntry.card.ready) {
      throw createHttpError(400, "That unit is not ready.");
    }
    if (attackerEntry.card.faceDown) {
      attackerEntry.card.faceDown = false;
    }

    const target = normalizeAttackTarget(payload.target);
    const defenderEntry = target.type === "unit" ? findBoardCard(defenderPlayer.board, target.instanceId) : null;
    if (target.type === "unit" && !defenderEntry) {
      throw createHttpError(404, "Defender not found on board.");
    }
    if (defenderEntry?.card?.faceDown) {
      throw createHttpError(400, "Facedown cards cannot be attacked or targeted.");
    }

    assertAttackTarget(attackerPlayer, attackerEntry, defenderEntry, target, defenderPlayer.board);

    const attackingReinforcer = payload.attackingReinforcerId
      ? requireBacklineReinforcer(attackerPlayer.board, payload.attackingReinforcerId, "Attacking")
      : null;
    if (attackingReinforcer) {
      const allowedReinforcers = new Set(listAttackingReinforcerChoices(attackerPlayer, attackerEntry).map((choice) => choice.id));
      if (!allowedReinforcers.has(attackingReinforcer.instanceId)) {
        throw createHttpError(400, "That unit cannot reinforce this attack.");
      }
    }

    const isFirstAttack = Number(attackerEntry.card.attackActionsTaken ?? 0) === 0;
    spendAttackAction(attackerPlayer, attackerEntry.card);
    attackerEntry.card.ready = false;
    attackerEntry.card.attackActionsTaken = Number(attackerEntry.card.attackActionsTaken ?? 0) + 1;
    attackerEntry.card.lastAttackTurn = game.turnNumber;
    maybeGrantErikaBonus(game, attackerPlayer, attackerEntry);
    if (attackingReinforcer) {
      attackingReinforcer.card.ready = false;
    }

    const byronRedirectChoices =
      target.type === "unit" && defenderEntry?.zone === "backline"
        ? listByronRedirectChoices(defenderPlayer, attackerPlayer)
        : [];
    if (byronRedirectChoices.length) {
      game.pendingAttack = {
        attackerSeat: attackerPlayer.seat,
        defenderSeat,
        attackerId: attackerEntry.instanceId,
        attackingReinforcerId: attackingReinforcer?.instanceId || null,
        isFirstAttack,
        target,
        phase: "redirect",
        declaredAt: new Date().toISOString()
      };
      game.lastEvent = {
        type: "attack",
        attackerSeat: attackerPlayer.seat,
        summary: `${attackerEntry.card.name} attacks ${defenderEntry.card.name}. Waiting for Byron redirect response.`
      };
      return this.buildView(game, attackerPlayer.seat);
    }

    if (target.type === "direct") {
      resolveAttack(game, {
        attackerSeat: attackerPlayer.seat,
        defenderSeat,
        attackerId: attackerEntry.instanceId,
        attackingReinforcerId: attackingReinforcer?.instanceId || null,
        isFirstAttack,
        target
      });
      return this.buildView(game, attackerPlayer.seat);
    }

    const defenseChoices =
      defenderEntry.zone === "frontline" && defenderEntry.card.name !== "Marcotte"
        ? listReadyBacklineReinforcers(defenderPlayer.board)
        : [];
    if (defenseChoices.length) {
      game.pendingAttack = {
        attackerSeat: attackerPlayer.seat,
        defenderSeat,
        attackerId: attackerEntry.instanceId,
        attackingReinforcerId: attackingReinforcer?.instanceId || null,
        isFirstAttack,
        target,
        phase: "defense",
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
      isFirstAttack,
      target
    });

    return this.buildView(game, attackerPlayer.seat);
  }

  respondToPendingAttack(gameId, playerId, defendingReinforcerId = null, redirectTargetId = null) {
    const game = this.requireGame(gameId);
    const player = this.requirePlayer(game, playerId);
    const pendingAttack = game.pendingAttack;

    if (!pendingAttack) {
      throw createHttpError(400, "There is no pending attack to respond to.");
    }
    if (player.seat !== pendingAttack.defenderSeat) {
      throw createHttpError(403, "Only the defending player can choose the defender reinforcer.");
    }

    if (pendingAttack.phase === "redirect") {
      if (redirectTargetId) {
        const defenderPlayer = game.players[pendingAttack.defenderSeat];
        const redirectEntry = findBoardCard(defenderPlayer.board, redirectTargetId);
        if (!redirectEntry || redirectEntry.zone !== "frontline" || redirectEntry.card.name !== "Byron" || redirectEntry.card.faceDown) {
          throw createHttpError(400, "Byron is not a valid redirect target.");
        }
        pendingAttack.target = { type: "unit", instanceId: redirectTargetId };
      }

      const defenderPlayer = game.players[pendingAttack.defenderSeat];
      const defenderEntry =
        pendingAttack.target.type === "unit" ? findBoardCard(defenderPlayer.board, pendingAttack.target.instanceId) : null;
      const defenseChoices =
        defenderEntry?.zone === "frontline" && defenderEntry.card.name !== "Marcotte"
          ? listReadyBacklineReinforcers(defenderPlayer.board)
          : [];
      if (defenseChoices.length) {
        pendingAttack.phase = "defense";
        game.lastEvent = {
          type: "attack",
          attackerSeat: pendingAttack.attackerSeat,
          summary: `${findBoardCard(game.players[pendingAttack.attackerSeat].board, pendingAttack.attackerId)?.card?.name || "Attacker"} attacks ${defenderEntry.card.name}. Waiting for defender reinforcement.`
        };
        return this.buildView(game, player.seat);
      }

      resolveAttack(game, { ...pendingAttack, phase: "defense" });
      return this.buildView(game, player.seat);
    }

    if (defendingReinforcerId) {
      const defenderPlayer = game.players[pendingAttack.defenderSeat];
      const defenderEntry = pendingAttack.target.type === "unit" ? findBoardCard(defenderPlayer.board, pendingAttack.target.instanceId) : null;
      if (!defenderEntry || defenderEntry.zone !== "frontline") {
        throw createHttpError(400, "Only an attacked frontline defender can be reinforced.");
      }
      if (defenderEntry.card.name === "Marcotte") {
        throw createHttpError(400, "Marcotte cannot be reinforced.");
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
    const endSummary = processEndOfTurnBoardEffects(game, player);
    const returnSummary = resolveEndOfTurnTemporaryControl(game, player.seat, game.turnNumber);
    const nextSeat = player.seat === "one" ? "two" : "one";
    beginTurn(game, nextSeat, { skipDraw: false, prelude: [endSummary, returnSummary].filter(Boolean).join(" ") });
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
      specialReveal: buildSpecialReveal(game, viewerSeat),
      players: {
        self: serializeSelf(viewer, opponent),
        opponent: serializeOpponent(opponent, viewer)
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
    blockedDrawActionTurn: null,
    currentTurnNumber: 0,
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

function buildSpecialReveal(game, viewerSeat) {
  if (game.lastEvent?.type === "play" && game.lastEvent?.attackerSeat === viewerSeat && Array.isArray(game.lastEvent?.revealedHand)) {
    return {
      type: "sir-damien-hand",
      sourceName: "Sir Damien",
      prompt: "Opponent hand revealed",
      cards: game.lastEvent.revealedHand
    };
  }
  return null;
}

function createEmptyBoard() {
  return {
    frontline: [],
    flank: [],
    backline: []
  };
}

function serializeSelf(player, opponent) {
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
    hand: player.hand.map((card) => serializeCard(player, opponent, card, { viewer: "self" })),
    board: serializeBoard(player, opponent, { viewer: "self" }),
    discard: player.discard.map((card) => serializeCard(player, opponent, card, { viewer: "self" })),
    discardCount: player.discard.length,
    drawActionBlocked: player.blockedDrawActionTurn === player.currentTurnNumber,
    supportActionsTakenThisTurn: player.supportActionsTakenThisTurn,
    availableAbilities: listAvailableAbilities(player, BOARD_ZONES),
    playableGraveyard: listPlayableGraveyardCards(player, BOARD_ZONES)
  };
}

function serializeOpponent(player, opponent) {
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
    board: serializeBoard(player, opponent, { viewer: "opponent" }),
    discard: player.discard.map((card) => serializeCard(player, opponent, card, { viewer: "opponent" })),
    discardCount: player.discard.length
  };
}

function beginTurn(game, seat, { skipDraw, prelude = "" }) {
  game.turnPlayerSeat = seat;
  game.turnNumber += 1;
  const actionsForTurn = game.turnNumber === 1 && seat === "one" ? OPENING_PLAYER_ACTIONS : ACTIONS_PER_TURN;

  for (const player of Object.values(game.players)) {
    player.actionsRemaining = player.seat === seat ? actionsForTurn : 0;
    player.currentTurnNumber = player.seat === seat ? game.turnNumber : player.currentTurnNumber;
    player.tempCardPower = {};
    player.tempGoblinPower = 0;
    player.directAttackIds = [];
    player.graveyardFreePlayUsed = false;
    player.supportActionsTakenThisTurn = 0;
    player.freeSupportActionsRemaining = 0;
  }

  readyBoard(game.players[seat].board);
  resetPerTurnCardState(game.players[seat].board);
  const startOfTurnSummary = processStartOfTurnBoardEffects(game, game.players[seat]);

  if (!skipDraw) {
    drawCards(game.players[seat], 1, { silentIfEmpty: true });
  }

  game.lastEvent = {
    type: "turn",
    attackerSeat: seat,
    summary: `${game.players[seat].selectedDeckName || "Player"} begins turn ${game.turnNumber}.${prelude ? ` ${prelude}` : ""}${startOfTurnSummary ? ` ${startOfTurnSummary}` : ""}`
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

function moveDiscardToHand(player, instanceId) {
  const index = player.discard.findIndex((card) => card.instanceId === instanceId);
  if (index === -1) {
    return null;
  }
  const [card] = player.discard.splice(index, 1);
  player.hand.push(card);
  return card;
}

function findHandCard(player, instanceId) {
  return player.hand.find((card) => card.instanceId === instanceId) || null;
}

function spendAction(player, amount) {
  if (player.actionsRemaining < amount) {
    throw createHttpError(400, "You do not have enough actions remaining.");
  }
  player.actionsRemaining -= amount;
}

function spendAttackAction(player, card) {
  const remaining = Number(card.freeAttackActionsRemaining ?? 0);
  if (remaining > 0) {
    card.freeAttackActionsRemaining = remaining - 1;
    return;
  }
  spendAction(player, 1);
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

function serializeBoard(player, opponent, options = {}) {
  return Object.fromEntries(
    BOARD_ZONES.map((zone) => [zone, player.board[zone].map((card) => serializeCard(player, opponent, card, options))])
  );
}

function serializeCard(player, opponent, card, { viewer = "self" } = {}) {
  if (card.faceDown && viewer !== "self") {
    return {
      ...card,
      name: "Facedown Card",
      text: "",
      flavourText: "",
      info: "",
      cardType: "",
      arcana: "",
      factionIconPaths: [],
      portraitPath: "/assets/general/CardReverse.png",
      cardAssetPath: "/assets/general/CardReverse.png",
      faceDown: true,
      revealOnHover: false,
      basePower: null,
      power: null
    };
  }

  return {
    ...card,
    portraitPath: card.faceDown ? "/assets/general/CardReverse.png" : card.portraitPath,
    revealOnHover: Boolean(card.faceDown),
    basePower: card.basePower ?? card.power ?? 0,
    power: getCardPower(player, card, opponent)
  };
}

function getCardPower(player, card, opponent = null, options = {}) {
  const basePower = Number(card.basePower ?? card.power ?? 0);
  const perCard = Number(player.tempCardPower?.[card.instanceId] ?? 0);
  const goblinBonus = isGoblinCard(card) ? Number(player.tempGoblinPower ?? 0) : 0;
  const marcotteBonus =
    !card.faceDown && card.name === "Marcotte" && findBoardCard(player.board, card.instanceId)?.zone === "frontline"
      ? player.board.backline.length
      : 0;
  const belielBonus = !card.faceDown && card.name === "Beliel" && !options.reinforced ? 2 : 0;
  const asmodeusAdjustment = !card.faceDown && card.name === "Asmodeus" ? -countCardsInPlayForEffects(player) : 0;
  if (!card.faceDown && card.name === "Gregorian") {
    return countCardsInPlayForEffects(opponent || { board: createEmptyBoard() }) + perCard + goblinBonus;
  }
  return basePower + perCard + goblinBonus + marcotteBonus + belielBonus + asmodeusAdjustment;
}

function setCardActionLock(card, turnNumber, seat) {
  card.actionLockedUntilTurn = turnNumber;
  card.actionLockedUntilSeat = seat;
}

function assertCardCanTakeActions(card, game, player) {
  if (
    card.actionLockedUntilTurn &&
    card.actionLockedUntilSeat &&
    game.turnPlayerSeat === player.seat &&
    card.actionLockedUntilSeat === player.seat &&
    game.turnNumber < card.actionLockedUntilTurn
  ) {
    throw createHttpError(400, `${card.name} cannot attack or take actions until your next turn.`);
  }
}

function listReadyBacklineReinforcers(board) {
  return (board.backline || [])
    .filter((card) => card.ready)
    .map((card) => ({ id: card.instanceId, name: card.name, power: card.basePower ?? card.power }));
}

function listAttackingReinforcerChoices(player, attackerEntry) {
  if (attackerEntry.card.name === "Marcotte") {
    return [];
  }

  if (attackerEntry.zone === "frontline") {
    return listReadyBacklineReinforcers(player.board);
  }

  if (attackerEntry.zone === "flank") {
    return (player.board.backline || [])
      .filter((card) => card.ready && card.name === "Slum Dweller")
      .map((card) => ({ id: card.instanceId, name: card.name, power: getCardPower(player, card) }));
  }

  return [];
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
    if (attackerEntry.card.name === "Lights Intent Officer" && target.type === "unit" && defenderEntry.zone === "backline") {
      throw createHttpError(400, "Lights Intent Officer cannot attack supports.");
    }
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
  const target = findBoardCard(player.board, instanceId);
  if (target?.card?.name === "Death") {
    return null;
  }
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

  const attackPower =
    getAttackActionPower(game, attackerPlayer, attackerEntry, { isFirstAttack: payload.isFirstAttack, reinforced: Boolean(attackingReinforcer) }) +
    Number(attackingReinforcer ? getCardPower(attackerPlayer, attackingReinforcer.card, defenderPlayer) : 0);
  const defensePower =
    Number(defenderEntry ? getCardPower(defenderPlayer, defenderEntry.card, attackerPlayer, { reinforced: Boolean(defendingReinforcer) }) : 0) +
    Number(defendingReinforcer ? getCardPower(defenderPlayer, defendingReinforcer.card, attackerPlayer) : 0);

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

  if (defenderDies) {
    applySeptarchyDestroyTriggers(game, attackerPlayer, defenderPlayer, attackerEntry, defenderEntry, attackPower);
    applyAdventurerDestroyTriggers(game, attackerPlayer, defenderPlayer, attackerEntry);
  }
  if (attackerDies) {
    applyAdventurerDestroyTriggers(game, defenderPlayer, attackerPlayer, defenderEntry);
  }

  if (attackerEntry.card.name === "Gelemire" && !defenderDies) {
    setCardActionLock(defenderEntry.card, game.turnNumber + 2, defenderPlayer.seat);
  }
  if (defenderEntry.card.name === "Gelemire" && !attackerDies) {
    setCardActionLock(attackerEntry.card, game.turnNumber + 2, attackerPlayer.seat);
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

  if (pendingAttack.phase === "redirect") {
    return {
      mode: "redirect",
      attackerName: attackerEntry.card.name,
      defenderName: defenderEntry.card.name,
      attacker: serializeCombatCard(attackerPlayer, attackerEntry, defenderPlayer),
      attackingReinforcer: attackingReinforcer ? serializeCombatCard(attackerPlayer, attackingReinforcer, defenderPlayer) : null,
      defender: serializeCombatCard(defenderPlayer, defenderEntry, attackerPlayer),
      choices: listByronRedirectChoices(defenderPlayer, attackerPlayer)
    };
  }

  return {
    mode: "defense",
    attackerName: attackerEntry.card.name,
    defenderName: defenderEntry.card.name,
    defenderId: defenderEntry.instanceId,
    attacker: serializeCombatCard(attackerPlayer, attackerEntry, defenderPlayer),
    attackingReinforcer: attackingReinforcer ? serializeCombatCard(attackerPlayer, attackingReinforcer, defenderPlayer) : null,
    defender: serializeCombatCard(defenderPlayer, defenderEntry, attackerPlayer),
    choices: listReadyBacklineReinforcersDetailed(defenderPlayer, attackerPlayer)
  };
}

function serializeCombatCard(player, entry, opponent = null) {
  return {
    id: entry.instanceId,
    name: entry.card.name,
    zone: entry.zone,
    power: getCardPower(player, entry.card, opponent),
    factionIconPaths: entry.card.factionIconPaths || [],
    portraitPath: entry.card.portraitPath || entry.card.cardAssetPath,
    cardAssetPath: entry.card.cardAssetPath
  };
}

function listReadyBacklineReinforcersDetailed(player, opponent = null) {
  return (player.board.backline || [])
    .filter((card) => card.ready)
    .map((card) => ({
      id: card.instanceId,
      name: card.name,
      power: getCardPower(player, card, opponent),
      factionIconPaths: card.factionIconPaths || [],
      portraitPath: card.portraitPath || card.cardAssetPath,
      cardAssetPath: card.cardAssetPath,
      zone: "backline"
    }));
}

function listByronRedirectChoices(player, opponent = null) {
  return (player.board.frontline || [])
    .filter((card) => !card.faceDown && card.name === "Byron")
    .map((card) => ({
      id: card.instanceId,
      name: card.name,
      power: getCardPower(player, card, opponent),
      factionIconPaths: card.factionIconPaths || [],
      portraitPath: card.portraitPath || card.cardAssetPath,
      cardAssetPath: card.cardAssetPath,
      zone: "frontline"
    }));
}

function getAttackActionPower(game, player, entry, { isFirstAttack = false, reinforced = false } = {}) {
  const opponent = game.players[player.seat === "one" ? "two" : "one"];
  let power = getCardPower(player, entry.card, opponent, { reinforced });

  if (entry.zone === "flank" && hasBoardCardNamedLocal(player.board, "Ogglethorpe", entry.instanceId)) {
    power += 1;
  }
  if (entry.card.name === "Thief") {
    power += 1;
  }
  if (entry.card.name === "Corric" && isFirstAttack) {
    power += 2;
  }
  if (entry.card.name === "Saladin") {
    power *= 2;
  }

  return power;
}

function applySeptarchyDestroyTriggers(game, attackerPlayer, defenderPlayer, attackerEntry, defenderEntry, attackPower) {
  if (attackerEntry.card.name === "Belthagor" && countCardsInPlayForEffects(attackerPlayer) < countCardsInPlayForEffects(defenderPlayer)) {
    attackerEntry.card.basePower = Number(attackerEntry.card.basePower ?? attackerEntry.card.power ?? 0) + 1;
  }
  if (attackerEntry.card.name === "Beliel") {
    const milled = Math.max(0, attackPower - Number(defenderEntry.card.basePower ?? defenderEntry.card.power ?? 0));
    if (milled > 0) {
      millCards(defenderPlayer, milled);
    }
  }
}

function applyAdventurerDestroyTriggers(game, attackerPlayer, defenderPlayer, attackerEntry) {
  if (attackerEntry.card.name === "Gavailey") {
    millCards(defenderPlayer, 1);
  }
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
        detail: `${zone} -> ${toZone}`,
        zone,
        power: Number(card.basePower ?? card.power ?? 0),
        cardAssetPath: card.cardAssetPath,
        factionIconPaths: card.factionIconPaths || []
      }))
    )
  );
}

function shiftBoardCard(player, instanceId, toZone) {
  for (const zone of BOARD_ZONES) {
    const index = player.board[zone].findIndex((card) => card.instanceId === instanceId);
    if (index !== -1) {
      const [card] = player.board[zone].splice(index, 1);
      if (!canCardChangeZonesByEffect(card)) {
        player.board[zone].splice(index, 0, card);
        throw createHttpError(400, `${card.name} may not be moved to another zone.`);
      }
      player.board[toZone].push({ ...card, zone: toZone });
      return;
    }
  }
}

function stealBoardCard(game, controllerSeat, instanceId) {
  const originalOwnerSeat = controllerSeat === "one" ? "two" : "one";
  const originalOwner = game.players[originalOwnerSeat];
  const controller = game.players[controllerSeat];
  const target = findBoardCard(originalOwner.board, instanceId);
  if (!target) {
    throw createHttpError(404, "Enemy card not found.");
  }
  if (target.card.faceDown) {
    throw createHttpError(400, "Facedown cards cannot be targeted by card effects.");
  }
  if (controller.board[target.zone].length >= BOARD_SLOTS_PER_ZONE) {
    throw createHttpError(400, "There is no room in that zone to steal the card.");
  }

  const index = originalOwner.board[target.zone].findIndex((card) => card.instanceId === instanceId);
  const [stolen] = originalOwner.board[target.zone].splice(index, 1);
  controller.board[target.zone].push({
    ...stolen,
    zone: target.zone,
    stolenFromSeat: originalOwnerSeat,
    stolenFromZone: target.zone,
    returnAtEndSeat: originalOwnerSeat,
    returnAtEndTurnNumber: game.turnNumber + 1
  });
  return stolen;
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

function summonAdventurerToken(player, zone, { name, cardType, basePower }) {
  if ((player.board[zone] || []).length >= BOARD_SLOTS_PER_ZONE) {
    return false;
  }

  player.board[zone].push({
    instanceId: `${slugifyName(name)}:${randomUUID().slice(0, 8)}`,
    cardId: slugifyName(name),
    name,
    faction: "Adventurer",
    factions: ["Adventurer"],
    factionIconPaths: ["/assets/factions/adventurer.svg"],
    cardType,
    arcana: "Chaff",
    basePower,
    power: basePower,
    text: "",
    flavourText: "",
    portraitPath: "",
    cardAssetPath: "/assets/general/CardReverse.png",
    zone,
    ready: zone === "backline",
    faceDown: false
  });
  return true;
}

function millCards(player, count) {
  const milled = player.deck.splice(0, count);
  player.discard.push(...milled);
}

function materializeCard(card) {
  return {
    ...card,
    basePower: Number(card.basePower ?? card.power ?? 0),
    power: Number(card.basePower ?? card.power ?? 0),
    attackActionsTaken: Number(card.attackActionsTaken ?? 0)
  };
}

function shouldEnterFaceDown(card, zone, options = {}) {
  if (options.faceDown) {
    return true;
  }
  return zone === "flank" && ["Saladin", "Corric", "Thief"].includes(card.name);
}

function playHandCardToBoard(player, instanceId, zone, { faceDown = false, payCardCost = true } = {}) {
  assertZoneKey(zone);
  if (player.board[zone].length >= BOARD_SLOTS_PER_ZONE) {
    throw createHttpError(400, "That zone is full.");
  }

  const cardIndex = player.hand.findIndex((card) => card.instanceId === instanceId);
  if (cardIndex === -1) {
    throw createHttpError(404, "Card not found in hand.");
  }

  const card = player.hand[cardIndex];
  assertCardCanEnterZone(card, zone);
  if (card.name === "Death" && zone !== "backline") {
    throw createHttpError(400, "Death may only be played in the backline.");
  }
  if (payCardCost) {
    spendAction(player, getCardPlayCost(card));
  }

  player.hand.splice(cardIndex, 1);
  const entersFaceDown = shouldEnterFaceDown(card, zone, { faceDown });
  const playedCard = { ...materializeCard(card), zone, ready: zone === "backline", faceDown: entersFaceDown };
  player.board[zone].push(playedCard);
  return playedCard;
}

function processStartOfTurnBoardEffects(game, player) {
  const deathInBackline = (player.board.backline || []).some((card) => !card.faceDown && card.name === "Death");
  const summaries = [];
  if (deathInBackline) {
    millCards(player, 1);
    summaries.push("Death milled 1 card.");
  }
  const hopelessAssistants = BOARD_ZONES.flatMap((zone) => player.board[zone]).filter(
    (card) => !card.faceDown && card.name === "Abaddon, Hopeless assistant"
  ).length;
  if (hopelessAssistants > 0) {
    player.actionsRemaining += hopelessAssistants;
    summaries.push(
      hopelessAssistants === 1
        ? "Abaddon, Hopeless assistant granted 1 extra action."
        : `Abaddon, Hopeless assistant granted ${hopelessAssistants} extra actions.`
    );
  }
  const jerrisSummary = queueJerrisAttackEffect(game, player);
  if (jerrisSummary) {
    summaries.push(jerrisSummary);
  }
  return summaries.join(" ");
}

function resolveEndOfTurnTemporaryControl(game, endingSeat, endingTurnNumber) {
  const returned = [];
  for (const holderSeat of BOARD_HOLDER_SEATS) {
    const holder = game.players[holderSeat];
    for (const zone of BOARD_ZONES) {
      for (let index = holder.board[zone].length - 1; index >= 0; index -= 1) {
        const card = holder.board[zone][index];
        if (card.returnAtEndSeat !== endingSeat || card.returnAtEndTurnNumber !== endingTurnNumber) {
          continue;
        }
        holder.board[zone].splice(index, 1);
        const owner = game.players[card.stolenFromSeat];
        owner.board[card.stolenFromZone].push({
          ...card,
          zone: card.stolenFromZone,
          stolenFromSeat: undefined,
          stolenFromZone: undefined,
          returnAtEndSeat: undefined,
          returnAtEndTurnNumber: undefined
        });
        returned.push(card.name);
      }
    }
  }
  return returned.length ? `${returned.join(", ")} returned to its owner.` : "";
}

const BOARD_HOLDER_SEATS = ["one", "two"];

function hasBoardCardNamedLocal(board, name, excludeId = null) {
  return BOARD_ZONES.some((zone) => board[zone].some((card) => !card.faceDown && card.name === name && card.instanceId !== excludeId));
}

function processEndOfTurnBoardEffects(game, player) {
  const summaries = [];
  const beliels = BOARD_ZONES.flatMap((zone) => player.board[zone]).filter((card) => card.name === "Beliel" && !card.faceDown);
  if (beliels.length > 0) {
    const millAmount = beliels.length * countCardsInPlayForEffects(player);
    if (millAmount > 0) {
      millCards(player, millAmount);
      summaries.push(`Beliel milled ${millAmount}.`);
    }
  }

  for (const zone of BOARD_ZONES) {
    for (const card of [...player.board[zone]]) {
      if (card.name === "Jerris" && card.lastAttackTurn !== game.turnNumber) {
        destroyBoardCard(game, player.seat, card.instanceId, "Jerris");
        summaries.push("Jerris was destroyed for not attacking.");
      }
    }
  }

  return summaries.join(" ");
}

function queueJerrisAttackEffect(game, player) {
  for (const zone of BOARD_ZONES) {
    for (const card of player.board[zone]) {
      if (card.name !== "Jerris") continue;
      const targets = collectJerrisTargets(game, player.seat, zone, card.instanceId);
      if (targets.length > 0 && player.actionsRemaining > 0) {
        game.pendingEffects.push({
          id: randomUUID(),
          type: "jerris-forced-attack",
          controllerSeat: player.seat,
          sourceName: "Jerris",
          prompt: "Jerris must attack a card in the same zone.",
          sourceId: card.instanceId,
          choices: targets
        });
        return "Jerris must attack.";
      }
    }
  }
  return "";
}

function collectJerrisTargets(game, seat, zone, excludeId) {
  return ["one", "two"].flatMap((holderSeat) =>
    game.players[holderSeat].board[zone]
      .filter((card) => card.instanceId !== excludeId)
      .map((card) => ({
        id: `${holderSeat}:${card.instanceId}`,
        targetSeat: holderSeat,
        targetId: card.instanceId,
        label: card.name,
        detail: `${holderSeat === seat ? "Your" : "Opponent"} ${zone}`,
        power: Number(card.basePower ?? card.power ?? 0),
        factionIconPaths: card.factionIconPaths || [],
        cardAssetPath: card.cardAssetPath
      }))
  );
}

function resolveJerrisForcedAttack(game, seat, sourceId, choice) {
  const attackerPlayer = game.players[seat];
  const defenderPlayer = game.players[choice.targetSeat];
  const attackerEntry = findBoardCard(attackerPlayer.board, sourceId);
  const defenderEntry = findBoardCard(defenderPlayer.board, choice.targetId);
  if (!attackerEntry || !defenderEntry) {
    throw createHttpError(400, "Jerris attack target is no longer valid.");
  }
  spendAction(attackerPlayer, 1);
  attackerEntry.card.ready = false;
  attackerEntry.card.lastAttackTurn = game.turnNumber;
  const attackPower = getCardPower(attackerPlayer, attackerEntry.card, defenderPlayer);
  const defensePower = getCardPower(defenderPlayer, defenderEntry.card, attackerPlayer);
  const attackerDies = attackerEntry.zone === "flank" ? defensePower >= attackPower : defensePower > attackPower;
  const defenderDies = attackerEntry.zone === "flank" ? attackPower >= defensePower : attackPower > defensePower;
  const defeated = [];
  if (defenderDies) defeated.push(destroyBoardCard(game, choice.targetSeat, defenderEntry.instanceId, attackerEntry.card.name));
  if (attackerDies) defeated.push(destroyBoardCard(game, seat, attackerEntry.instanceId, defenderEntry.card.name));
  game.lastEvent = {
    type: "trigger",
    attackerSeat: seat,
    summary: buildAttackSummary({ attacker: "Jerris", defender: defenderEntry.card.name, attackPower, defensePower, defeated })
  };
}

function resetPerTurnCardState(board) {
  for (const zone of BOARD_ZONES) {
    for (const card of board[zone]) {
      card.freeAttackActionsRemaining = 0;
      card.erikaBonusGrantedTurn = null;
    }
  }
}

function assertCardCanEnterZone(card, zone) {
  if (card.name === "Lance" && zone !== "frontline") {
    throw createHttpError(400, "Lance may only be played in the frontline.");
  }
}

function canCardChangeZonesByEffect(card) {
  return !["Death"].includes(card.name);
}

function assertCardCanUseMoveAction(card) {
  if (["Death", "Lance"].includes(card.name)) {
    throw createHttpError(400, `${card.name} may not be moved to another zone.`);
  }
}

function maybeGrantErikaBonus(game, player, attackerEntry) {
  if (attackerEntry.card.name === "Erika") {
    return;
  }
  if (attackerEntry.card.erikaBonusGrantedTurn === game.turnNumber) {
    return;
  }
  const hasFaceUpErika = BOARD_ZONES.some((zone) =>
    player.board[zone].some((card) => !card.faceDown && card.name === "Erika")
  );
  if (!hasFaceUpErika) {
    return;
  }
  attackerEntry.card.ready = true;
  attackerEntry.card.freeAttackActionsRemaining = Number(attackerEntry.card.freeAttackActionsRemaining ?? 0) + 1;
  attackerEntry.card.erikaBonusGrantedTurn = game.turnNumber;
}

function slugifyName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
  player.currentTurnNumber = 5;
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
