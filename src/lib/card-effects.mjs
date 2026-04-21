import { randomUUID } from "node:crypto";

export function isGoblinCard(card) {
  return String(card.cardType ?? "").toLowerCase().includes("goblin");
}

const CARD_ABILITY_DEFINITIONS = {
  "Hydra, Goblin King": {
    label: "Devour Goblin",
    type: "hydra-devour",
    kind: "activated",
    speed: "free",
    actionCost: 0,
    requiresReady: false,
    allowedZones: ["frontline", "flank", "backline"],
    exhaustsSource: false,
    targetPrompt: "Choose a Goblin to destroy"
  },
  "Orc Marksmen": {
    label: "Rally Goblins",
    type: "orc-marksmen",
    kind: "activated",
    speed: "free",
    actionCost: 0,
    requiresReady: false,
    allowedZones: ["frontline", "flank", "backline"],
    exhaustsSource: false,
    targetPrompt: "Choose a Goblin to destroy"
  },
  "Goblin Warchief": {
    label: "Support",
    type: "goblin-warchief",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a Goblin to support"
  },
  Twist: {
    label: "Free Shift",
    type: "twist-shift",
    kind: "activated",
    speed: "free",
    actionCost: 0,
    requiresReady: false,
    allowedZones: ["frontline", "flank", "backline"],
    exhaustsSource: false,
    targetPrompt: "Choose a zone to shift Twist into"
  },
  Listener: {
    label: "Flip Facedown",
    type: "listener-facedown",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a card in your flank zone"
  },
  Watcher: {
    label: "Deploy Facedown",
    type: "watcher-facedown-play",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a non-major card from your hand"
  },
  Albert: {
    label: "Mill and Draw",
    type: "albert-mill-draw",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true
  },
  Gunsmith: {
    label: "Arm Flanker",
    type: "gunsmith-buff",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a card in your flank zone"
  },
  "The Warden": {
    label: "Reposition Enemy",
    type: "warden-move-enemy",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose an enemy card to move"
  },
  "Father Sentar": {
    label: "Suppress",
    type: "father-sentar-suppress",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose an enemy card"
  },
  Catherine: {
    label: "Recover",
    type: "catherine-return",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a card in your graveyard"
  },
  Death: {
    label: "Harvest",
    type: "death-harvest",
    kind: "support",
    speed: "support",
    actionCost: 1,
    requiresReady: true,
    allowedZones: ["backline"],
    exhaustsSource: true,
    targetPrompt: "Choose a card in your graveyard"
  }
};

export function getCardAbility(card) {
  return CARD_ABILITY_DEFINITIONS[card.name] || null;
}

export function getAbilityActionCost(player, ability) {
  if (ability.kind === "support" && Number(player.freeSupportActionsRemaining ?? 0) > 0) {
    return 0;
  }
  return Number(ability.actionCost ?? 0);
}

export function listAvailableAbilities(player, boardZones) {
  return boardZones.flatMap((zone) =>
    player.board[zone].flatMap((card) => {
      if (card.faceDown) {
        return [];
      }

      const ability = getCardAbility(card);
      if (!ability) {
        return [];
      }

      const inAllowedZone = !ability.allowedZones || ability.allowedZones.includes(zone);
      const meetsReadyRequirement = !ability.requiresReady || card.ready;
      const notActionLocked =
        !card.actionLockedUntilTurn ||
        card.actionLockedUntilSeat !== player.seat ||
        Number(player.currentTurnNumber ?? 0) >= Number(card.actionLockedUntilTurn);
      const withinTurnLimit = card.name !== "Twist" || card.lastFreeShiftTurn !== player.currentTurnNumber;
      if (!inAllowedZone || !meetsReadyRequirement || !withinTurnLimit || !notActionLocked) {
        return [];
      }

      return [
        {
          sourceId: card.instanceId,
          label: ability.label,
          type: ability.type,
          kind: ability.kind,
          speed: ability.speed,
          actionCost: getAbilityActionCost(player, ability),
          baseActionCost: Number(ability.actionCost ?? 0),
          targetPrompt: ability.targetPrompt
        }
      ];
    })
  );
}

export function listPlayableGraveyardCards(player, boardZones) {
  return player.discard
    .filter((card) => canPlayFromGraveyard(player, card, boardZones))
    .map((card) => card.instanceId);
}

export function canPlayFromGraveyard(player, card, boardZones) {
  const canPlayChaffGoblin =
    isGoblinCard(card) &&
    String(card.arcana ?? "").toLowerCase() === "chaff" &&
    hasBoardCardNamed(player, "Goblin, Goblin King", boardZones);
  const canPlayFreeSharedOneDrop =
    Number(card.basePower ?? card.power ?? 0) === 1 &&
    !player.graveyardFreePlayUsed &&
    hasBoardCardNamed(player, "Abaddon, Goblin King", boardZones) &&
    boardZones.some((zone) =>
      player.board[zone].some((boardCard) => !boardCard.faceDown && boardCard.name === "Abaddon, Goblin King" && sharesFaction(boardCard, card))
    );

  return canPlayChaffGoblin || canPlayFreeSharedOneDrop;
}

export function executeCardAbility({ game, player, sourceEntry, payload, helpers }) {
  const {
    spendAction,
    destroyControlledGoblin,
    findBoardCard,
    countGoblinCards,
    createHttpError,
    shiftBoardCard,
    millCards,
    drawCards,
    moveDiscardToHand,
    setCardActionLock
  } = helpers;
  const ability = getCardAbility(sourceEntry.card);
  if (!ability) {
    throw createHttpError(400, "That card does not have a usable ability yet.");
  }

  if (ability.allowedZones && !ability.allowedZones.includes(sourceEntry.zone)) {
    throw createHttpError(400, `${sourceEntry.card.name} cannot use that ability from the ${sourceEntry.zone}.`);
  }
  if (ability.requiresReady && !sourceEntry.card.ready) {
    throw createHttpError(400, `${sourceEntry.card.name} is not ready.`);
  }

  if (sourceEntry.card.name === "Hydra, Goblin King") {
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    destroyControlledGoblin(game, player.seat, payload.targetId, sourceEntry.card.name);
    if (findBoardCard(player.board, sourceEntry.instanceId)) {
      player.tempCardPower[sourceEntry.instanceId] = Number(player.tempCardPower[sourceEntry.instanceId] ?? 0) + 1;
    }
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: "Hydra, Goblin King devoured a Goblin and gained +1 power this turn."
    };
    return;
  }

  if (sourceEntry.card.name === "Orc Marksmen") {
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    destroyControlledGoblin(game, player.seat, payload.targetId, sourceEntry.card.name);
    player.tempGoblinPower = Number(player.tempGoblinPower ?? 0) + 1;
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: "Orc Marksmen rallied your Goblins with +1 power this turn."
    };
    return;
  }

  if (sourceEntry.card.name === "Goblin Warchief") {
    const targetEntry = findBoardCard(player.board, payload.targetId);
    if (!targetEntry || !isGoblinCard(targetEntry.card)) {
      throw createHttpError(400, "Goblin Warchief must target a Goblin you control.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    const buffAmount = countGoblinCards(player.discard);
    player.tempCardPower[targetEntry.instanceId] = Number(player.tempCardPower[targetEntry.instanceId] ?? 0) + buffAmount;
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Goblin Warchief gave ${targetEntry.card.name} +${buffAmount} power this turn.`
    };
    return;
  }

  if (sourceEntry.card.name === "Twist") {
    if (!payload.toZone) {
      throw createHttpError(400, "Twist must choose a destination zone.");
    }
    if (payload.toZone === sourceEntry.zone) {
      throw createHttpError(400, "Twist is already in that zone.");
    }
    if (player.board[payload.toZone].length >= 7) {
      throw createHttpError(400, "That zone is full.");
    }
    sourceEntry.card.lastFreeShiftTurn = player.currentTurnNumber;
    shiftBoardCard(player, sourceEntry.instanceId, payload.toZone);
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Twist shifted into the ${payload.toZone} for free.`
    };
    return;
  }

  if (sourceEntry.card.name === "Listener") {
    const targetEntry = findBoardCard(player.board, payload.targetId);
    if (!targetEntry || targetEntry.zone !== "flank") {
      throw createHttpError(400, "Listener must target a card in your flank zone.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    targetEntry.card.faceDown = true;
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `${targetEntry.card.name} was flipped facedown in the flank.`
    };
    return;
  }

  if (sourceEntry.card.name === "Watcher") {
    const candidate = payload.instanceId ? helpers.findHandCard(player, payload.instanceId) : null;
    if (!candidate) {
      throw createHttpError(400, "Watcher must play a non-major card from your hand facedown into the flank.");
    }
    if (String(candidate.arcana ?? "").toLowerCase() === "major") {
      throw createHttpError(400, "Watcher cannot play a major card facedown.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    const played = helpers.playHandCardToBoard(player, payload.instanceId, "flank", { faceDown: true, payCardCost: false });
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Watcher played ${played.name} facedown into the flank.`
    };
    return;
  }

  if (sourceEntry.card.name === "Albert") {
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    millCards(player, 1);
    drawCards(player, 2, { silentIfEmpty: true });
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: "Albert milled 1 and drew 2 cards."
    };
    return;
  }

  if (sourceEntry.card.name === "Gunsmith") {
    const targetEntry = findBoardCard(player.board, payload.targetId);
    if (!targetEntry || targetEntry.zone !== "flank") {
      throw createHttpError(400, "Gunsmith must target a card in your flank zone.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    player.tempCardPower[targetEntry.instanceId] = Number(player.tempCardPower[targetEntry.instanceId] ?? 0) + 4;
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Gunsmith gave ${targetEntry.card.name} +4 power this turn.`
    };
    return;
  }

  if (sourceEntry.card.name === "The Warden") {
    const opponentSeat = player.seat === "one" ? "two" : "one";
    const targetEntry = findBoardCard(game.players[opponentSeat].board, payload.targetId);
    if (!targetEntry || !payload.toZone) {
      throw createHttpError(400, "The Warden needs an enemy target and destination.");
    }
    if (targetEntry.card.faceDown) {
      throw createHttpError(400, "Facedown cards cannot be targeted by card effects.");
    }
    if (targetEntry.zone === payload.toZone) {
      throw createHttpError(400, "The Warden must move the target to a different zone.");
    }
    if (game.players[opponentSeat].board[payload.toZone].length >= 7) {
      throw createHttpError(400, "That destination zone is full.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    shiftBoardCard(game.players[opponentSeat], targetEntry.instanceId, payload.toZone);
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `The Warden moved ${targetEntry.card.name} to the ${payload.toZone}.`
    };
    return;
  }

  if (sourceEntry.card.name === "Father Sentar") {
    const opponentSeat = player.seat === "one" ? "two" : "one";
    const targetEntry = findBoardCard(game.players[opponentSeat].board, payload.targetId);
    if (!targetEntry) {
      throw createHttpError(400, "Father Sentar must target an enemy card.");
    }
    if (targetEntry.card.faceDown) {
      throw createHttpError(400, "Facedown cards cannot be targeted by card effects.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    setCardActionLock(targetEntry.card, player.currentTurnNumber + 2, opponentSeat);
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `${targetEntry.card.name} cannot attack or take actions until ${player.selectedDeckName || "your"} next turn.`
    };
    return;
  }

  if (sourceEntry.card.name === "Catherine") {
    const exists = player.discard.some((card) => card.instanceId === payload.targetId);
    if (!exists) {
      throw createHttpError(400, "Catherine must return a card from your graveyard.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    const returned = moveDiscardToHand(player, payload.targetId);
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Catherine returned ${returned.name} from your graveyard to your hand.`
    };
    return;
  }

  if (sourceEntry.card.name === "Death") {
    const exists = player.discard.some((card) => card.instanceId === payload.targetId);
    if (!exists) {
      throw createHttpError(400, "Death must return a card from your graveyard.");
    }
    commitAbilityCost(player, sourceEntry.card, ability, { spendAction });
    millCards(player, 1);
    const returned = moveDiscardToHand(player, payload.targetId);
    game.lastEvent = {
      type: "ability",
      attackerSeat: player.seat,
      summary: `Death milled 1 and returned ${returned.name} from your graveyard to your hand.`
    };
    return;
  }
}

function commitAbilityCost(player, sourceCard, ability, helpers) {
  const actionCost = getAbilityActionCost(player, ability);
  if (ability.kind === "support") {
    player.supportActionsTakenThisTurn = Number(player.supportActionsTakenThisTurn ?? 0) + 1;
    if (actionCost > 0 && hasBoardCardNamed(player, "Abaddon, False Cleric", ["frontline", "flank", "backline"])) {
      player.freeSupportActionsRemaining = Number(player.freeSupportActionsRemaining ?? 0) + 1;
    }
    if (actionCost === 0 && Number(player.freeSupportActionsRemaining ?? 0) > 0) {
      player.freeSupportActionsRemaining -= 1;
    }
  }
  if (actionCost) {
    helpers.spendAction(player, actionCost);
  }
  if (ability.exhaustsSource) {
    sourceCard.ready = false;
  }
}

export function handleCardPlayed(game, player, card, helpers = {}) {
  const opponentSeat = player.seat === "one" ? "two" : "one";
  const opponent = game.players[opponentSeat];
  const { summonAdventurerToken, drawCards, moveDiscardToHand, destroyBoardCard, shiftBoardCard } = helpers;

  if (card.name === "Lana") {
    summonAdventurerToken?.(player, card.zone, { name: "Spider Token", cardType: "Spider", basePower: 1 });
    summonAdventurerToken?.(player, card.zone, { name: "Justice Token", cardType: "Justice", basePower: 2 });
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: "Lana played a Spider token and a Justice token into the same zone."
    };
    return;
  }

  if (card.name === "Dronan") {
    if (player.discard.length > 0) {
      const randomIndex = Math.floor(Math.random() * player.discard.length);
      const returned = player.discard.splice(randomIndex, 1)[0];
      player.hand.push(returned);
      game.lastEvent = {
        type: "play",
        attackerSeat: player.seat,
        summary: `Dronan returned ${returned.name} from your graveyard to your hand.`
      };
    }
    return;
  }

  if (card.name === "Rinse") {
    const opponentCards = ["frontline", "flank", "backline"].flatMap((zone) =>
      opponent.board[zone].filter((entry) => !entry.faceDown).map((entry) => ({
        id: entry.instanceId,
        label: entry.name,
        detail: `Opponent ${zone}`,
        zone,
        power: Number(entry.basePower ?? entry.power ?? 0),
        factionIconPaths: entry.factionIconPaths || [],
        cardAssetPath: entry.cardAssetPath
      }))
    );
    const selfCards = ["frontline", "flank", "backline"].flatMap((zone) =>
      player.board[zone].filter((entry) => !entry.faceDown).map((entry) => ({
        id: entry.instanceId,
        label: entry.name,
        detail: `Your ${zone}`,
        zone,
        power: Number(entry.basePower ?? entry.power ?? 0),
        factionIconPaths: entry.factionIconPaths || [],
        cardAssetPath: entry.cardAssetPath
      }))
    );
    if (opponentCards.length >= 1 && selfCards.length >= 1) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "rinse-chaos",
        controllerSeat: player.seat,
        sourceName: card.name,
        prompt: "Choose enemy cards, then your own cards. Rinse will randomly destroy one from each group.",
        opponentChoices: opponentCards,
        selfChoices: selfCards,
        maxOpponentSelections: Math.min(2, opponentCards.length),
        maxSelfSelections: Math.min(2, selfCards.length)
      });
    } else {
      game.lastEvent = {
        type: "play",
        attackerSeat: player.seat,
        summary: "Rinse had too few valid targets to cause chaos."
      };
    }
    return;
  }

  if (card.name === "Ztun") {
    if (drawCards) {
      drawCards(player, 1, { silentIfEmpty: true });
    } else if (player.deck.length > 0) {
      player.hand.push(...player.deck.splice(0, 1));
    }
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: "Ztun drew a card."
    };
    return;
  }

  if (card.name === "Reese") {
    const cardsInPlay = ["frontline", "flank", "backline"].flatMap((zone) =>
      player.board[zone].filter((entry) => !entry.faceDown).map((entry) => ({
        id: entry.instanceId,
        label: entry.name,
        detail: `Your ${zone}`,
        zone,
        power: Number(entry.basePower ?? entry.power ?? 0),
        factionIconPaths: entry.factionIconPaths || [],
        cardAssetPath: entry.cardAssetPath
      }))
    );
    if (cardsInPlay.length >= 2) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "reese-swap",
        controllerSeat: player.seat,
        sourceName: card.name,
        prompt: "Choose two cards on your side to swap positions.",
        choices: cardsInPlay
      });
    }
    return;
  }

  if (card.name === "Moss") {
    card.ready = true;
    card.freeAttackActionsRemaining = Number(card.freeAttackActionsRemaining ?? 0) + 1;
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: "Moss may attack this turn without spending a turn action."
    };
    return;
  }

  if (card.name === "Bernadette") {
    summonSquibbyToken(player, card.zone);
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: "Bernadette played a Squibby token into the same zone."
    };
    return;
  }

  if (card.name === "Lilith") {
    if (countCardsInPlayForEffects(player) < countCardsInPlayForEffects(opponent)) {
      player.hand.push(...player.deck.splice(0, 1));
      game.lastEvent = {
        type: "play",
        attackerSeat: player.seat,
        summary: "Lilith drew a card because you control fewer cards than your opponent."
      };
    }
    return;
  }

  if (card.name === "Praxis") {
    game.players[opponentSeat].blockedDrawActionTurn = game.turnNumber + 1;
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: "Praxis prevents the opponent from taking the draw action on their next turn."
    };
    return;
  }

  if (card.name === "Medicarium Cleric") {
    const choices = player.discard.map((entry) => ({
      id: entry.instanceId,
      label: entry.name,
      detail: "Shuffle into deck"
    }));
    if (choices.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "medicarium-cleric-heal",
        controllerSeat: player.seat,
        sourceName: card.name,
        prompt: "Choose a card in your graveyard to shuffle back into your deck.",
        choices
      });
    }
    return;
  }

  if (card.name === "Biddimim") {
    const topTwo = player.deck.slice(0, 2);
    if (!topTwo.length) {
      return;
    }
    const ids = topTwo.map((entry) => entry.instanceId);
    const choices = buildTopDeckOrderChoices(topTwo);
    game.pendingEffects.push({
      id: randomUUID(),
      type: "biddimim-reorder",
      controllerSeat: player.seat,
      sourceName: card.name,
      prompt: "Choose how to place the top two cards of your deck.",
      choices,
      cardIds: ids,
      cards: topTwo.map((entry) => ({
        id: entry.instanceId,
        name: entry.name,
        power: Number(entry.basePower ?? entry.power ?? 0),
        factionIconPaths: entry.factionIconPaths || [],
        cardAssetPath: entry.cardAssetPath,
        detail: entry.arcana ? `${entry.arcana} ${entry.cardType || ""}`.trim() : entry.cardType || ""
      }))
    });
    return;
  }

  if (card.name === "Sir Damien") {
    const opponentCards = game.players[opponentSeat].hand.map((entry) => ({
      instanceId: entry.instanceId,
      name: entry.name,
      power: Number(entry.basePower ?? entry.power ?? 0),
      factionIconPaths: entry.factionIconPaths || [],
      portraitPath: entry.portraitPath || entry.cardAssetPath,
      cardAssetPath: entry.cardAssetPath,
      cardType: entry.cardType || "",
      arcana: entry.arcana || ""
    }));
    const opponentHand = opponentCards.map((entry) => entry.name).join(", ") || "no cards";
    game.lastEvent = {
      type: "play",
      attackerSeat: player.seat,
      summary: `Sir Damien reveals the opponent hand: ${opponentHand}.`,
      revealedHand: opponentCards
    };
    return;
  }

  if (card.name === "Alieah") {
    const legalTargets = ["frontline", "flank", "backline"].flatMap((zone) =>
      game.players[opponentSeat].board[zone]
        .filter((entry) => !entry.faceDown && game.players[player.seat].board[zone].length < 7)
        .map((entry) => ({
          id: entry.instanceId,
          label: entry.name,
          detail: `Steal from ${zone}`,
          zone,
          power: Number(entry.basePower ?? entry.power ?? 0),
          factionIconPaths: entry.factionIconPaths || [],
          cardAssetPath: entry.cardAssetPath
        }))
    );
    if (legalTargets.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "alieah-steal",
        controllerSeat: player.seat,
        sourceName: card.name,
        prompt: "You may mill 1 card to take control of an enemy card until the end of your opponent's next turn.",
        choices: legalTargets
      });
    }
    return;
  }
}

export function enqueueDeathTriggers(game, ownerSeat, opponentSeat, destroyed, helpers) {
  const { collectGoblinTargets, collectShiftChoices } = helpers;

  if (destroyed.name === "Goblin Scout") {
    const owner = game.players[ownerSeat];
    const choices = collectGoblinTargets(owner.board, destroyed.instanceId);
    if (choices.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "goblin-scout",
        controllerSeat: ownerSeat,
        sourceName: destroyed.name,
        prompt: "Choose another Goblin you control that may attack directly this turn.",
        choices
      });
    }
  }

  if (destroyed.name === "Two Goblins") {
    game.pendingEffects.push({
      id: randomUUID(),
      type: "two-goblins",
      controllerSeat: ownerSeat,
      sourceName: destroyed.name
    });
  }

  if (destroyed.name === "Goblin Strategist") {
    const choices = collectShiftChoices(game.players[opponentSeat].board);
    if (choices.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "goblin-strategist",
        controllerSeat: ownerSeat,
        sourceName: destroyed.name,
        prompt: "Choose an opposing card to shift and its new zone.",
        choices
      });
    }
  }

  if (destroyed.name === "Abaddon, Dragon fanatic") {
    const owner = game.players[ownerSeat];
    const choices = owner.deck
      .filter((card) => sharesFaction(destroyed, card))
      .map((card) => ({ id: card.instanceId, label: card.name, detail: card.factions.join(", ") }));
    if (choices.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "dragon-fanatic",
        controllerSeat: ownerSeat,
        sourceName: destroyed.name,
        prompt: "Choose a shared-faction card from your deck to add to your hand.",
        choices
      });
    }
  }

  if (destroyed.name === "Goblin Pillager") {
    game.pendingEffects.push({
      id: randomUUID(),
      type: "goblin-pillager",
      controllerSeat: ownerSeat,
      opponentSeat,
      sourceName: destroyed.name
    });
  }

  if (destroyed.name === "Vainglory") {
    const owner = game.players[ownerSeat];
    const choices = owner.discard
      .filter((card) => card.instanceId !== destroyed.instanceId)
      .map((card) => ({
        id: card.instanceId,
        label: card.name,
        detail: "Return to hand",
        power: Number(card.basePower ?? card.power ?? 0),
        factionIconPaths: card.factionIconPaths || [],
        cardAssetPath: card.cardAssetPath
      }));
    if (choices.length) {
      game.pendingEffects.push({
        id: randomUUID(),
        type: "vainglory-return",
        controllerSeat: ownerSeat,
        sourceName: destroyed.name,
        prompt: "Choose a different card in your graveyard to return to your hand.",
        choices
      });
    }
  }
}

export function flushPendingEffects(game, helpers) {
  const { summonGoblinToken, millCards } = helpers;

  while (game.pendingEffects.length) {
    const effect = game.pendingEffects[0];
    if (effect.type === "two-goblins") {
      summonGoblinToken(game.players[effect.controllerSeat]);
      game.lastEvent = {
        type: "trigger",
        attackerSeat: effect.controllerSeat,
        summary: "Two Goblins left behind a Goblin token."
      };
      game.pendingEffects.shift();
      continue;
    }

    if (effect.type === "goblin-pillager") {
      millCards(game.players[effect.opponentSeat], 3);
      game.lastEvent = {
        type: "trigger",
        attackerSeat: effect.controllerSeat,
        summary: "Goblin Pillager milled 3 cards from the opponent."
      };
      game.pendingEffects.shift();
      continue;
    }

    break;
  }
}

export function buildPendingEffectChoice(game, viewerSeat) {
  const effect = game.pendingEffects[0];
  if (!effect || effect.controllerSeat !== viewerSeat) {
    return null;
  }

  return {
    id: effect.id,
    type: effect.type,
    sourceName: effect.sourceName,
    prompt: effect.prompt,
    choices: effect.choices || [],
    cards: effect.cards || [],
    opponentChoices: effect.opponentChoices || [],
    selfChoices: effect.selfChoices || [],
    maxOpponentSelections: effect.maxOpponentSelections ?? 0,
    maxSelfSelections: effect.maxSelfSelections ?? 0
  };
}

export function applyPendingEffectChoice(game, effect, choiceId, helpers) {
  const {
    createHttpError,
    shiftBoardCard,
    millCards,
    stealBoardCard,
    resolveJerrisForcedAttack,
    moveDiscardToHand,
    destroyBoardCard
  } = helpers;
  const player = game.players[effect.controllerSeat];

  if (effect.type === "goblin-scout") {
    const choice = effect.choices.find((option) => option.id === choiceId);
    if (!choice) {
      throw createHttpError(400, "A target is required for Goblin Scout.");
    }
    if (!player.directAttackIds.includes(choice.id)) {
      player.directAttackIds.push(choice.id);
    }
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `${choice.label} may attack directly this turn.`
    };
    return;
  }

  if (effect.type === "goblin-strategist") {
    const choice = effect.choices.find((option) => option.id === choiceId);
    if (!choice) {
      throw createHttpError(400, "A shift destination is required.");
    }
    shiftBoardCard(game.players[effect.controllerSeat === "one" ? "two" : "one"], choice.targetId, choice.toZone);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `${choice.label} was shifted to the ${choice.toZone}.`
    };
    return;
  }

  if (effect.type === "reese-swap") {
    const [, firstId = "", secondId = ""] = String(choiceId || "").split("|");
    if (!firstId || !secondId || firstId === secondId) {
      throw createHttpError(400, "Choose two valid cards to swap.");
    }
    const firstEntry = findAnyBoardEntry(player, firstId);
    const secondEntry = findAnyBoardEntry(player, secondId);
    if (!firstEntry || !secondEntry) {
      throw createHttpError(400, "One of those Reese targets is no longer in play.");
    }
    swapBoardCards(player, firstEntry, secondEntry);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `${firstEntry.card.name} and ${secondEntry.card.name} swapped positions.`
    };
    return;
  }

  if (effect.type === "rinse-chaos") {
    let parsedChoice;
    try {
      parsedChoice = JSON.parse(String(choiceId || "{}"));
    } catch {
      throw createHttpError(400, "Choose valid targets for Rinse.");
    }
    const opponentIds = Array.isArray(parsedChoice?.opponentIds) ? parsedChoice.opponentIds.filter(Boolean) : [];
    const selfIds = Array.isArray(parsedChoice?.selfIds) ? parsedChoice.selfIds.filter(Boolean) : [];
    const opponentSeat = effect.controllerSeat === "one" ? "two" : "one";
    const opponent = game.players[opponentSeat];
    if (!opponentIds.length || !selfIds.length) {
      throw createHttpError(400, "Choose at least one enemy card and one friendly card for Rinse.");
    }
    const maxOpponentSelections = Math.min(Number(effect.maxOpponentSelections ?? 2), 2);
    const maxSelfSelections = Math.min(Number(effect.maxSelfSelections ?? 2), 2);
    if (
      opponentIds.length > maxOpponentSelections ||
      selfIds.length > maxSelfSelections ||
      new Set(opponentIds).size !== opponentIds.length ||
      new Set(selfIds).size !== selfIds.length
    ) {
      throw createHttpError(400, "Choose a valid number of targets for Rinse.");
    }
    const opponentTargets = opponentIds.map((id) => findAnyBoardEntry(opponent, id)).filter(Boolean);
    const selfTargets = selfIds.map((id) => findAnyBoardEntry(player, id)).filter(Boolean);
    if (opponentTargets.length !== opponentIds.length || selfTargets.length !== selfIds.length) {
      throw createHttpError(400, "Rinse's targets are no longer valid.");
    }
    const destroyedOpponent = opponentTargets[Math.floor(Math.random() * opponentTargets.length)];
    const destroyedSelf = selfTargets[Math.floor(Math.random() * selfTargets.length)];
    destroyBoardCard(game, opponentSeat, destroyedOpponent.card.instanceId, "Rinse");
    destroyBoardCard(game, effect.controllerSeat, destroyedSelf.card.instanceId, "Rinse");
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `Rinse destroyed ${destroyedOpponent.card.name} and ${destroyedSelf.card.name}.`
    };
    return;
  }

  if (effect.type === "dragon-fanatic") {
    const index = player.deck.findIndex((card) => card.instanceId === choiceId);
    if (index === -1) {
      throw createHttpError(400, "Choose a valid deck card to search.");
    }
    const [card] = player.deck.splice(index, 1);
    player.hand.push(card);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `Abaddon, Dragon fanatic searched ${card.name} into hand.`
    };
    return;
  }

  if (effect.type === "medicarium-cleric-heal") {
    const index = player.discard.findIndex((card) => card.instanceId === choiceId);
    if (index === -1) {
      throw createHttpError(400, "Choose a valid graveyard card to heal.");
    }
    const [card] = player.discard.splice(index, 1);
    player.deck.push(card);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `Medicarium Cleric healed ${card.name} back into the deck.`
    };
    return;
  }

  if (effect.type === "vainglory-return") {
    const returned = moveDiscardToHand(player, choiceId);
    if (!returned) {
      throw createHttpError(400, "Choose a valid graveyard card to return.");
    }
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `Vainglory returned ${returned.name} from your graveyard to your hand.`
    };
    return;
  }

  if (effect.type === "biddimim-reorder") {
    const choice = effect.choices.find((option) => option.id === choiceId);
    if (!choice) {
      throw createHttpError(400, "Choose an order for the top cards.");
    }
    const selected = effect.cardIds
      .map((id) => player.deck.find((card) => card.instanceId === id))
      .filter(Boolean);
    player.deck = player.deck.filter((card) => !effect.cardIds.includes(card.instanceId));
    const topCards = choice.toTop
      .map((id) => selected.find((card) => card.instanceId === id))
      .filter(Boolean);
    const bottomCards = choice.toBottom
      .map((id) => selected.find((card) => card.instanceId === id))
      .filter(Boolean);
    player.deck.unshift(...topCards);
    player.deck.push(...bottomCards);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: "Biddimim reordered the top two cards of the deck."
    };
    return;
  }

  if (effect.type === "alieah-steal") {
    if (!choiceId) {
      game.lastEvent = {
        type: "trigger",
        attackerSeat: effect.controllerSeat,
        summary: "Alieah declined to steal a card."
      };
      return;
    }
    const choice = effect.choices.find((option) => option.id === choiceId);
    if (!choice) {
      throw createHttpError(400, "Choose a valid enemy card to steal.");
    }
    millCards(player, 1);
    const stolen = stealBoardCard(game, effect.controllerSeat, choice.id);
    game.lastEvent = {
      type: "trigger",
      attackerSeat: effect.controllerSeat,
      summary: `Alieah stole ${stolen.name} until the end of the opponent's next turn.`
    };
    return;
  }

  if (effect.type === "jerris-forced-attack") {
    const choice = effect.choices.find((option) => option.id === choiceId);
    if (!choice) {
      throw createHttpError(400, "Choose a valid card for Jerris to attack.");
    }
    resolveJerrisForcedAttack(game, effect.controllerSeat, effect.sourceId, choice);
    return;
  }

  throw createHttpError(400, "That triggered effect is not implemented.");
}

export function countCardsInPlayForEffects(player) {
  return ["frontline", "flank", "backline"].reduce(
    (total, zone) => total + player.board[zone].filter((card) => countsAsInPlayForEffects(card)).length,
    0
  );
}

export function countsAsInPlayForEffects(card) {
  return !["Abaddon, Lord Sloth", "Imp", "Squibby Token"].includes(card.name);
}

function summonSquibbyToken(player, zone) {
  if ((player.board[zone] || []).length >= 7) {
    return;
  }
  player.board[zone].push({
    instanceId: `squibby-token:${randomUUID().slice(0, 8)}`,
    cardId: "squibby-token",
    name: "Squibby Token",
    faction: "Septarchy",
    factions: ["Septarchy"],
    factionIconPaths: ["/assets/factions/septarchy.svg"],
    cardType: "Imp",
    arcana: "Chaff",
    basePower: 1,
    power: 1,
    text: "If you need to count the number of cards you have in play, do not count this card",
    flavourText: "",
    portraitPath: "",
    cardAssetPath: "/output/cards/imp.svg",
    zone,
    ready: zone === "backline",
    faceDown: false
  });
}

function hasBoardCardNamed(player, name, boardZones) {
  return boardZones.some((zone) => player.board[zone].some((card) => !card.faceDown && card.name === name));
}

function sharesFaction(cardA, cardB) {
  return (cardA.factions || []).some((faction) => (cardB.factions || []).includes(faction));
}

function buildTopDeckOrderChoices(cards) {
  if (cards.length === 1) {
    return [{ id: "keep-top-one", label: `${cards[0].name} on top`, toTop: [cards[0].instanceId], toBottom: [] }];
  }

  const [first, second] = cards;
  return [
    { id: "keep-order-top", label: `${first.name} then ${second.name} on top`, toTop: [first.instanceId, second.instanceId], toBottom: [] },
    { id: "reverse-order-top", label: `${second.name} then ${first.name} on top`, toTop: [second.instanceId, first.instanceId], toBottom: [] },
    { id: "first-top-second-bottom", label: `${first.name} on top, ${second.name} on bottom`, toTop: [first.instanceId], toBottom: [second.instanceId] },
    { id: "second-top-first-bottom", label: `${second.name} on top, ${first.name} on bottom`, toTop: [second.instanceId], toBottom: [first.instanceId] },
    { id: "both-bottom", label: `Put both on the bottom`, toTop: [], toBottom: [first.instanceId, second.instanceId] }
  ];
}

function findAnyBoardEntry(player, instanceId) {
  for (const zone of ["frontline", "flank", "backline"]) {
    const index = player.board[zone].findIndex((card) => card.instanceId === instanceId);
    if (index !== -1) {
      return { zone, index, card: player.board[zone][index] };
    }
  }
  return null;
}

function swapBoardCards(player, firstEntry, secondEntry) {
  if (firstEntry.zone === secondEntry.zone) {
    const zoneCards = player.board[firstEntry.zone];
    [zoneCards[firstEntry.index], zoneCards[secondEntry.index]] = [zoneCards[secondEntry.index], zoneCards[firstEntry.index]];
    return;
  }

  const firstCard = player.board[firstEntry.zone][firstEntry.index];
  const secondCard = player.board[secondEntry.zone][secondEntry.index];
  player.board[firstEntry.zone][firstEntry.index] = { ...secondCard, zone: firstEntry.zone };
  player.board[secondEntry.zone][secondEntry.index] = { ...firstCard, zone: secondEntry.zone };
}

function destroyBoardEntry(game, ownerSeat, instanceId) {
  const player = game.players[ownerSeat];
  for (const zone of ["frontline", "flank", "backline"]) {
    const index = player.board[zone].findIndex((card) => card.instanceId === instanceId);
    if (index !== -1) {
      const [card] = player.board[zone].splice(index, 1);
      player.discard.push(card);
      return card;
    }
  }
  return null;
}
