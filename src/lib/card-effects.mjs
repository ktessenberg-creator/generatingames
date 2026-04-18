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
      const ability = getCardAbility(card);
      if (!ability) {
        return [];
      }

      const inAllowedZone = !ability.allowedZones || ability.allowedZones.includes(zone);
      const meetsReadyRequirement = !ability.requiresReady || card.ready;
      if (!inAllowedZone || !meetsReadyRequirement) {
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
      player.board[zone].some((boardCard) => boardCard.name === "Abaddon, Goblin King" && sharesFaction(boardCard, card))
    );

  return canPlayChaffGoblin || canPlayFreeSharedOneDrop;
}

export function executeCardAbility({ game, player, sourceEntry, payload, helpers }) {
  const { spendAction, destroyControlledGoblin, findBoardCard, countGoblinCards, createHttpError } = helpers;
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
}

function commitAbilityCost(player, sourceCard, ability, helpers) {
  const actionCost = getAbilityActionCost(player, ability);
  if (ability.kind === "support") {
    player.supportActionsTakenThisTurn = Number(player.supportActionsTakenThisTurn ?? 0) + 1;
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
    choices: effect.choices || []
  };
}

export function applyPendingEffectChoice(game, effect, choiceId, helpers) {
  const { createHttpError, shiftBoardCard } = helpers;
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

  throw createHttpError(400, "That triggered effect is not implemented.");
}

function hasBoardCardNamed(player, name, boardZones) {
  return boardZones.some((zone) => player.board[zone].some((card) => card.name === name));
}

function sharesFaction(cardA, cardB) {
  return (cardA.factions || []).some((faction) => (cardB.factions || []).includes(faction));
}
