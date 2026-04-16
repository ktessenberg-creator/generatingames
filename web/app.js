const state = {
  gameId: null,
  playerId: null,
  guestToken: null,
  decks: [],
  testGame: null,
  view: null,
  viewHash: "",
  dragPayload: null,
  pointerDrag: null
};

const setupView = document.querySelector("#setup-view");
const setupPanel = document.querySelector("#setup-panel");
const mainLayout = document.querySelector("#main-layout");
const lobbyActions = document.querySelector("#lobby-actions");
const statusBanner = document.querySelector("#status-banner");
const testLinks = document.querySelector("#test-links");
const opponentBoard = document.querySelector("#opponent-board");
const selfBoard = document.querySelector("#self-board");
const selfHand = document.querySelector("#self-hand");
const handMeta = document.querySelector("#hand-meta");
const turnControls = document.querySelector("#turn-controls");
const modalHost = createModalHost();
const pageBody = document.body;

await bootstrap();

async function bootstrap() {
  const params = new URLSearchParams(window.location.search);
  state.gameId = params.get("game");
  state.playerId = params.get("player");
  state.guestToken = params.get("join");
  state.decks = (await api("/api/decks")).decks;
  state.testGame = (await api("/api/test-game")).testGame;

  if (state.gameId && state.guestToken && !state.playerId) {
    const joined = await api(`/api/games/${state.gameId}/join`, {
      method: "POST",
      body: { guestToken: state.guestToken }
    });
    updateUrl(joined.gameId, joined.playerId);
  }

  if (state.gameId && state.playerId) {
    await refreshView();
  }

  ensurePointerDragBindings();
  ensureBoardInteractionBindings();
  ensureControlBindings();
  render();
  setInterval(async () => {
    if (state.gameId && state.playerId) {
      const changed = await refreshView();
      if (changed) {
        render();
      }
    }
  }, 2500);
}

function render() {
  renderLayoutState();
  renderLobbyActions();
  renderStatus();
  renderTestLinks();
  renderTurnControls();
  renderPendingDefenseChoice();
  renderPendingEffectChoice();
  renderSetup();
  renderBoards();
}

function renderTestLinks() {
  if (!state.testGame) {
    testLinks.classList.add("hidden");
    testLinks.innerHTML = "";
    return;
  }

  const hostUrl = `${window.location.origin}${state.testGame.hostPath}`;
  const guestUrl = `${window.location.origin}${state.testGame.guestPath}`;
  testLinks.classList.remove("hidden");
  testLinks.innerHTML = `
    <div class="test-link-copy">
      <strong>Fast Test Board</strong>
      <span>Open either player view straight into a preloaded mid-game board state.</span>
    </div>
    <div class="test-link-grid">
      <a class="test-link-card" href="${hostUrl}">
        <span>Player One</span>
        <code>${hostUrl}</code>
      </a>
      <a class="test-link-card" href="${guestUrl}">
        <span>Player Two</span>
        <code>${guestUrl}</code>
      </a>
    </div>
  `;
}

function renderLayoutState() {
  const hideSetup = state.view?.status === "active";
  setupPanel.classList.toggle("hidden", hideSetup);
  mainLayout.classList.toggle("game-live", hideSetup);
}

function renderLobbyActions() {
  if (!state.gameId || !state.playerId) {
    lobbyActions.innerHTML = `<button class="primary" id="create-game">Create New Game</button>`;
    document.querySelector("#create-game").onclick = createGame;
    return;
  }

  const inviteUrl = `${window.location.origin}/?game=${state.gameId}&join=${state.view?.inviteToken || state.guestToken || ""}`;
  lobbyActions.innerHTML = `
    <div class="invite-box">
      <label>Invite Link</label>
      <input type="text" readonly value="${inviteUrl}" />
      <button class="secondary" id="copy-link">Copy</button>
    </div>
  `;

  document.querySelector("#copy-link").onclick = async () => {
    await navigator.clipboard.writeText(inviteUrl);
  };
}

function renderStatus() {
  if (!state.view) {
    statusBanner.classList.add("hidden");
    return;
  }

  statusBanner.classList.remove("hidden");
  const { status, turnPlayerSeat, viewerSeat, turnNumber, winnerSeat, lastEvent } = state.view;
  if (status === "completed") {
    statusBanner.textContent = `${winnerSeat === viewerSeat ? "VICTORY" : "DEFEAT"} • ${lastEvent?.summary || "The game is over."}`;
    return;
  }

  const turnText =
    status === "active"
      ? turnPlayerSeat === viewerSeat
        ? "Your turn"
        : "Opponent turn"
      : "Waiting in lobby";
  statusBanner.textContent = `${status.toUpperCase()} • Turn ${turnNumber || 0} • ${turnText}`;
}

function renderTurnControls() {
  if (!state.view || state.view.status !== "active") {
    turnControls.classList.add("hidden");
    turnControls.innerHTML = "";
    return;
  }

  const self = state.view.players.self;
  const isYourTurn = state.view.turnPlayerSeat === state.view.viewerSeat;
  const canSpendAction = isYourTurn && self.actionsRemaining > 0;
  const spent = 3 - self.actionsRemaining;
  const actionDots = Array.from({ length: 3 }, (_, index) => {
    const spentClass = index < spent ? "spent" : "";
    return `<span class="action-dot ${spentClass}"></span>`;
  }).join("");

  turnControls.classList.remove("hidden");
  turnControls.innerHTML = `
    <div class="turn-ribbon">
      <div class="turn-copy">
        <strong>${isYourTurn ? "Your turn" : "Opponent turn"}</strong>
        <span>${self.actionsRemaining} actions remaining</span>
      </div>
      <div class="action-track" aria-label="${self.actionsRemaining} actions remaining">
        ${actionDots}
      </div>
      <div class="turn-actions">
        <button class="primary action-button" id="end-turn" ${isYourTurn ? "" : "disabled"}>End Turn</button>
      </div>
      ${state.view.lastEvent?.summary ? `<p class="event-line">${state.view.lastEvent.summary}</p>` : ""}
    </div>
  `;
}

function renderPendingDefenseChoice() {
  const pending = state.view?.pendingDefenseChoice;
  if (!pending) {
    if (modalHost.dataset.mode === "pending-defense") {
      modalHost.innerHTML = "";
      modalHost.dataset.mode = "";
    }
    return;
  }

  modalHost.dataset.mode = "pending-defense";
  modalHost.innerHTML = `
    <div class="modal-scrim">
      <div class="modal-card combat-modal">
        <h3>Defensive Reinforcement</h3>
        <p>${pending.attackerName} is attacking ${pending.defenderName}. Choose one ready backliner to reinforce, or decline.</p>
        <div class="combat-preview-grid">
          <section class="combat-preview-column">
            <span class="combat-preview-label">Attacking</span>
            <div class="combat-preview-stack">
              ${renderCombatPreviewCard(pending.attacker, "attacker")}
              ${
                pending.attackingReinforcer
                  ? `
                    <div class="combat-preview-connector">+</div>
                    ${renderCombatPreviewCard(pending.attackingReinforcer, "reinforcer")}
                  `
                  : ""
              }
            </div>
          </section>
          <section class="combat-preview-column">
            <span class="combat-preview-label">Defending</span>
            <div class="combat-preview-stack combat-preview-stack-defense">
              <div class="combat-preview-defense-card">
                ${renderCombatPreviewCard(pending.defender, "defender")}
              </div>
              <div class="combat-preview-defense-options">
                <span class="combat-preview-option-label">Reinforce With</span>
                <div class="modal-options combat-option-grid defense-option-grid">
                  ${pending.choices
                    .map(
                      (option) => renderCombatOptionCard(option, "data-defense-choice")
                    )
                    .join("")}
                </div>
              </div>
            </div>
          </section>
        </div>
        <div class="modal-actions">
          <button class="primary" data-defense-choice="">No Reinforcer</button>
        </div>
      </div>
    </div>
  `;

  for (const button of modalHost.querySelectorAll("[data-defense-choice]")) {
    button.onclick = async () => {
      const choice = button.dataset.defenseChoice || null;
      try {
        await api(`/api/games/${state.gameId}/respond-attack`, {
          method: "POST",
          body: { playerId: state.playerId, defendingReinforcerId: choice }
        });
        await refreshView();
        modalHost.innerHTML = "";
        modalHost.dataset.mode = "";
        render();
      } catch (error) {
        window.alert(error.message);
      }
    };
  }
}

function renderCombatPreviewCard(card, role = "") {
  if (!card) {
    return "";
  }

  return `
    <article class="combat-preview-card ${role ? `is-${role}` : ""}">
      <img src="${card.cardAssetPath}" alt="${card.name}" draggable="false" />
      <div class="combat-preview-copy">
        <strong>${card.name}</strong>
        <span>${card.zone} • ${card.power} power</span>
      </div>
      <div class="card-hover combat-card-hover">
        <img src="${card.cardAssetPath}" alt="${card.name}" draggable="false" />
      </div>
    </article>
  `;
}

function renderCombatOptionCard(option, attributeName = "data-choice") {
  return `
    <button class="secondary modal-option combat-option-card" ${attributeName}="${option.id}">
      <img src="${option.cardAssetPath}" alt="${option.name}" draggable="false" />
      <strong>${option.name}</strong>
      <span>${option.power} power</span>
      <div class="card-hover combat-card-hover">
        <img src="${option.cardAssetPath}" alt="${option.name}" draggable="false" />
      </div>
    </button>
  `;
}

function renderPendingEffectChoice() {
  const pending = state.view?.pendingEffectChoice;
  if (!pending) {
    if (modalHost.dataset.mode === "pending-effect") {
      modalHost.innerHTML = "";
      modalHost.dataset.mode = "";
    }
    return;
  }

  modalHost.dataset.mode = "pending-effect";
  modalHost.innerHTML = `
    <div class="modal-scrim">
      <div class="modal-card">
        <h3>${pending.sourceName}</h3>
        <p>${pending.prompt}</p>
        <div class="modal-options">
          ${pending.choices
            .map(
              (choice) => `
                <button class="secondary modal-option" data-effect-choice="${choice.id}">
                  <strong>${choice.label}</strong>
                  <span>${choice.detail || ""}</span>
                </button>
              `
            )
            .join("")}
        </div>
      </div>
    </div>
  `;

  for (const button of modalHost.querySelectorAll("[data-effect-choice]")) {
    button.onclick = async () => {
      try {
        await api(`/api/games/${state.gameId}/resolve-effect`, {
          method: "POST",
          body: { playerId: state.playerId, choiceId: button.dataset.effectChoice }
        });
        await refreshView();
        modalHost.innerHTML = "";
        modalHost.dataset.mode = "";
        render();
      } catch (error) {
        window.alert(error.message);
      }
    };
  }
}

function renderSetup() {
  if (!state.gameId || !state.playerId) {
    setupView.innerHTML = `
      <p>Start a fresh game, then open the invite link in a second tab or browser for the other player.</p>
    `;
    return;
  }

  const self = state.view.players.self;
  const opponent = state.view.players.opponent;
  const deckButtons = state.decks
    .map(
      (deck) => `
        <button class="${self.deckId === deck.id ? "selected" : ""}" data-deck="${deck.id}">
          <strong>${deck.name}</strong>
          <span>${deck.uniqueCards} unique cards • ${deck.cardCount} cards</span>
        </button>
      `
    )
    .join("");

  setupView.innerHTML = `
    <div class="stack">
      <div class="player-summary">
        <p><strong>You:</strong> ${self.deckName || "No deck selected"}</p>
        <p><strong>Opponent:</strong> ${opponent.deckName || "Waiting for deck choice"}</p>
      </div>
      <div class="deck-grid">${deckButtons}</div>
      <div class="stack horizontal">
        <button class="primary" id="start-game" ${state.view.canStart ? "" : "disabled"}>Start Game</button>
      </div>
    </div>
  `;

  for (const button of setupView.querySelectorAll("[data-deck]")) {
    button.onclick = async () => {
      await api(`/api/games/${state.gameId}/choose-deck`, {
        method: "POST",
        body: { playerId: state.playerId, deckId: button.dataset.deck }
      });
      await refreshView();
      render();
    };
  }

  document.querySelector("#start-game").onclick = async () => {
    await api(`/api/games/${state.gameId}/start`, {
      method: "POST",
      body: { playerId: state.playerId }
    });
    await refreshView();
    render();
  };
}

function renderBoards() {
  if (!state.view) {
    opponentBoard.innerHTML = "";
    selfBoard.innerHTML = "";
    selfHand.innerHTML = "";
    handMeta.textContent = "";
    return;
  }

  const self = state.view.players.self;
  const opponent = state.view.players.opponent;
  const canAttack = state.view.status === "active" && state.view.turnPlayerSeat === state.view.viewerSeat;
  const playableGraveyard = new Set(self.playableGraveyard || []);
  const canDraw = state.view.status === "active" && state.view.turnPlayerSeat === state.view.viewerSeat && self.actionsRemaining > 0;

  handMeta.innerHTML = `<span>${self.handCount} cards • ${self.deckCount} in deck • ${self.discardCount} discard</span>`;

  opponentBoard.innerHTML = renderBattlefield(opponent.board, {
    interactive: false,
    mirrored: true,
    attackSurface: canAttack,
    lifeTotal: opponent.lifeTotal,
    discard: opponent.discard || [],
    deckCount: opponent.deckCount ?? 0,
    playableGraveyard: new Set(),
    canDraw: false,
    isSelf: false
  });
  selfBoard.innerHTML = renderBattlefield(self.board, {
    interactive: true,
    mirrored: false,
    attackSurface: false,
    lifeTotal: self.lifeTotal,
    discard: self.discard || [],
    deckCount: self.deckCount ?? 0,
    playableGraveyard,
    canDraw,
    isSelf: true
  });

  selfHand.innerHTML = self.hand.length
    ? self.hand.map((card) => renderHandCard(card)).join("")
    : `<div class="empty">Your hand is empty</div>`;

  const graveyardButtons = document.querySelectorAll("[data-play-graveyard]");
  for (const button of graveyardButtons) {
    button.onclick = async () => {
      try {
        await api(`/api/games/${state.gameId}/play-from-graveyard`, {
          method: "POST",
          body: {
            playerId: state.playerId,
            instanceId: button.dataset.playGraveyard,
            zone: button.dataset.zone
          }
        });
        await refreshView();
        render();
      } catch (error) {
        window.alert(error.message);
      }
    };
  }

  for (const button of document.querySelectorAll("[data-open-graveyard]")) {
    button.onclick = () => {
      const mine = button.dataset.openGraveyard === "self";
      openGraveyardBrowser(mine ? self.discard || [] : opponent.discard || [], playableGraveyard, mine);
    };
  }
}

function renderHandCard(card) {
  return `
    <article class="card-tile hand-card" data-drag-card="${card.instanceId}">
      <img src="${card.cardAssetPath}" alt="${card.name}" draggable="false" />
      <div class="card-hover hand-hover">
        <img src="${card.cardAssetPath}" alt="${card.name}" draggable="false" />
      </div>
    </article>
  `;
}

function renderGraveyard(label, discard, playableGraveyard, isSelf) {
  const topCard = discard.at(-1);
  const stackLayers = Math.min(discard.length, 3);

  return `
    <div class="graveyard-header">
      <h3>${label}</h3>
      <div class="graveyard-meta">
        <span>${discard.length} cards</span>
        <button class="secondary graveyard-browse" data-open-graveyard="${isSelf ? "self" : "opponent"}">View</button>
      </div>
    </div>
    ${
      topCard
        ? `
          <div class="graveyard-stack ${stackLayers > 1 ? "is-stacked" : ""}" style="--stack-depth:${stackLayers}">
            <div class="graveyard-card-stack" aria-hidden="true">
              ${Array.from({ length: Math.max(0, stackLayers - 1) }, () => `<span class="grave-card-shadow"></span>`).join("")}
            </div>
            <article class="graveyard-card">
              <img src="${topCard.cardAssetPath}" alt="${topCard.name}" />
              <div class="graveyard-copy">
                <strong>${topCard.name}</strong>
                <span>${topCard.power} power</span>
              </div>
              ${
                isSelf && playableGraveyard.has(topCard.instanceId)
                  ? `
                    <div class="graveyard-actions">
                      <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="frontline">Front</button>
                      <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="flank">Flank</button>
                      <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="backline">Back</button>
                    </div>
                  `
                  : ""
              }
            </article>
          </div>
        `
        : `<div class="graveyard-empty">No destroyed units yet</div>`
    }
  `;
}

function renderBattlefield(board, options, mirroredFlag = false) {
  const normalized = typeof options === "boolean" ? { interactive: options, mirrored: mirroredFlag } : options;
  const interactive = normalized?.interactive ?? false;
  const mirrored = normalized?.mirrored ?? false;
  const attackSurface = normalized?.attackSurface ?? false;
  const lifeTotal = normalized?.lifeTotal;
  const discard = normalized?.discard || [];
  const playableGraveyard = normalized?.playableGraveyard || new Set();
  const deckCount = normalized?.deckCount ?? 0;
  const canDraw = normalized?.canDraw ?? false;
  const isSelf = normalized?.isSelf ?? false;
  const frontline = renderZone("Frontline", "frontline", board.frontline, interactive, false, attackSurface);
  const flank = renderZone("Flank", "flank", board.flank, interactive, true, attackSurface);
  const backline = renderZone("Backline", "backline", board.backline, interactive, false, attackSurface);
  const graveyardPocket = renderGraveyardPocket(discard, playableGraveyard, isSelf);
  const deckPocket = renderDeckPocket(deckCount, canDraw, isSelf);
  const leaderPocket = renderLeaderPocket(lifeTotal, attackSurface, isSelf);
  const topLeft = mirrored ? deckPocket : graveyardPocket;
  const bottomLeft = mirrored ? graveyardPocket : deckPocket;
  const topMain = mirrored
    ? `
      <div class="battle-main-stack battle-main-stack-top">
        ${leaderPocket}
        ${backline}
      </div>
    `
    : frontline;
  const bottomMain = mirrored
    ? frontline
    : `
      <div class="battle-main-stack battle-main-stack-bottom">
        ${backline}
        ${leaderPocket}
      </div>
    `;

  return `
    <div class="battlefield-grid">
      <div class="battle-pocket battle-pocket-top-left">
        ${topLeft}
      </div>
      <div class="battle-main battle-main-top">
        ${topMain}
      </div>
      <div class="battle-flank">
        ${flank}
      </div>
      <div class="battle-pocket battle-pocket-bottom-left">
        ${bottomLeft}
      </div>
      <div class="battle-main battle-main-bottom">
        ${bottomMain}
      </div>
    </div>
  `;
}

function renderDeckPocket(deckCount, canDraw, isSelf) {
  const cardCountLabel = deckCount === 1 ? "1 card" : `${deckCount} cards`;
  return `
    <section class="battle-pocket-card deck-pocket ${isSelf ? "is-self" : ""}">
      <div class="battle-pocket-overlay">
        <div class="battle-pocket-chip battle-pocket-count">${cardCountLabel}</div>
        ${isSelf ? `<button class="secondary pocket-action pocket-overlay-action" id="draw-card" ${canDraw ? "" : "disabled"}>Draw</button>` : ""}
      </div>
      <div class="deck-icon" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </section>
  `;
}

function renderLeaderPocket(lifeTotal, attackSurface, isSelf) {
  if (attackSurface) {
    return `
      <section class="leader-drop" data-attack-direct="true" data-target-type="direct">
        <span>Direct Attack</span>
        <strong>${lifeTotal} life</strong>
      </section>
    `;
  }

  return `
    <section class="leader-drop own-life">
      <span>${isSelf ? "Your Life" : "Life"}</span>
      <strong>${lifeTotal} life</strong>
    </section>
  `;
}

function renderGraveyardPocket(discard, playableGraveyard, isSelf) {
  const topCard = discard.at(-1);
  const stackLayers = Math.min(discard.length, 3);
  const topPlayable = topCard && isSelf && playableGraveyard.has(topCard.instanceId);

  return `
    <section class="battle-pocket-card graveyard-pocket">
      <div class="battle-pocket-overlay">
        <div class="battle-pocket-chip battle-pocket-count">${discard.length} ${discard.length === 1 ? "card" : "cards"}</div>
        <button class="secondary graveyard-browse pocket-overlay-action" data-open-graveyard="${isSelf ? "self" : "opponent"}">View</button>
      </div>
      ${
        topCard
          ? `
            <div class="graveyard-pocket-stack ${stackLayers > 1 ? "is-stacked" : ""}">
              <div class="graveyard-card-stack" aria-hidden="true">
                ${Array.from({ length: Math.max(0, stackLayers - 1) }, () => `<span class="grave-card-shadow"></span>`).join("")}
              </div>
              <article class="graveyard-card compact">
                <img src="${topCard.cardAssetPath}" alt="${topCard.name}" />
              </article>
            </div>
          `
          : `<div class="graveyard-empty compact">Empty</div>`
      }
      <div class="graveyard-pocket-actions">
        ${
          topPlayable
            ? `
              <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="frontline">F</button>
              <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="flank">L</button>
              <button class="secondary graveyard-play" data-play-graveyard="${topCard.instanceId}" data-zone="backline">B</button>
            `
            : ""
        }
      </div>
    </section>
  `;
}

function renderZone(label, zoneKey, cards, interactive, vertical = false, attackSurface = false) {
  return `
    <section class="board-zone ${vertical ? "vertical-zone" : ""}" ${interactive ? `data-drop-zone="${zoneKey}"` : ""}>
      <header>${label}</header>
      <div class="board-cards ${vertical ? "vertical-cards" : ""}">
        ${cards.length ? cards.map((card) => renderBoardCard(card, interactive, attackSurface)).join("") : `<div class="empty-slot">${interactive ? "Drop here" : "Empty"}</div>`}
      </div>
    </section>
  `;
}

function renderBoardCard(card, interactive, attackSurface = false) {
  const portraitSrc = card.portraitPath || card.cardAssetPath;
  const attackTargetAttrs = attackSurface ? `data-attack-target="true" data-target-type="unit" data-target-id="${card.instanceId}" data-target-zone="${card.zone || ""}"` : "";
  const readinessClass = card.ready ? "is-ready" : "is-exhausted";
  const hasAbility = interactive && state.view?.players?.self?.availableAbilities?.some((entry) => entry.sourceId === card.instanceId);
  return `
    <article class="board-card ${readinessClass} ${hasAbility ? "has-ability" : ""}" data-board-card-id="${card.instanceId}" data-card-name="${card.name}" ${attackTargetAttrs} ${interactive ? `data-drag-board-card="${card.instanceId}" data-zone="${card.zone || ""}"` : ""}>
      <img src="${portraitSrc}" alt="${card.name}" draggable="false" />
      <span class="board-card-name">${card.name}</span>
      <span class="power-chip">${card.power}</span>
      <div class="card-hover">
        <img src="${card.cardAssetPath}" alt="${card.name}" draggable="false" />
      </div>
    </article>
  `;
}

function ensurePointerDragBindings() {
  if (document.body.dataset.pointerDragBound) {
    return;
  }

  const beginDragIntent = (event) => {
    if (
      event.button !== 0 ||
      isModalOpen() ||
      !state.view ||
      state.view.status !== "active" ||
      state.view.turnPlayerSeat !== state.view.viewerSeat
    ) {
      return;
    }

    const handCard = event.target.closest?.("[data-drag-card]");
    if (handCard && selfHand.contains(handCard)) {
      pageBody.classList.add("drag-arming");
      state.pointerDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        payload: { type: "hand", instanceId: handCard.dataset.dragCard },
        previewSrc: handCard.querySelector("img")?.src || "",
        sourceElement: handCard
      };
      return;
    }

    const boardCard = event.target.closest?.("[data-drag-board-card]");
    if (boardCard && selfBoard.contains(boardCard)) {
      pageBody.classList.add("drag-arming");
      state.pointerDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
        payload: {
          type: "board",
          instanceId: boardCard.dataset.dragBoardCard,
          zone: boardCard.dataset.zone
        },
        previewSrc: boardCard.querySelector("img")?.src || "",
        sourceElement: boardCard
      };
    }
  };

  selfHand.addEventListener("pointerdown", beginDragIntent);
  selfBoard.addEventListener("pointerdown", beginDragIntent);

  window.addEventListener("pointermove", (event) => {
    const drag = state.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (isModalOpen()) {
      state.pointerDrag = null;
      clearDragPayload();
      return;
    }

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < 8) {
      return;
    }

    if (!drag.active) {
      activatePointerDrag(drag, event.clientX, event.clientY);
    }

    event.preventDefault();
    updatePointerDragPosition(event.clientX, event.clientY);
    updatePointerHighlightsForPosition(event.clientX, event.clientY, drag.payload);
  }, { passive: false });

  window.addEventListener("pointerup", async (event) => {
    const drag = state.pointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    if (!drag.active) {
      state.pointerDrag = null;
      pageBody.classList.remove("drag-arming");
      return;
    }

    event.preventDefault();
    await finalizePointerDrop(event.clientX, event.clientY, drag.payload);
    clearDragPayload();
    state.pointerDrag = null;
  }, { passive: false });

  window.addEventListener("pointercancel", () => {
    state.pointerDrag = null;
    clearDragPayload();
  });

  document.body.dataset.pointerDragBound = "true";
}

function ensureBoardInteractionBindings() {
  if (document.body.dataset.boardInteractionBound) {
    return;
  }

  selfBoard.addEventListener("click", async (event) => {
    if (state.dragPayload) {
      return;
    }
    const card = event.target.closest?.("[data-board-card-id]");
    if (!card) {
      return;
    }

    const self = state.view?.players?.self;
    const abilityMap = new Map((self?.availableAbilities || []).map((ability) => [ability.sourceId, ability]));
    const ability = abilityMap.get(card.dataset.boardCardId);
    if (!ability) {
      return;
    }

    try {
      const selectedAction = await chooseCardAction(card.dataset.cardName, ability);
      if (selectedAction !== "use") {
        return;
      }
      const body = await buildAbilityRequest(ability, self);
      await api(`/api/games/${state.gameId}/use-ability`, {
        method: "POST",
        body: { playerId: state.playerId, sourceId: card.dataset.boardCardId, ...body }
      });
      await refreshView();
      render();
    } catch (error) {
      window.alert(error.message);
    }
  });

  document.body.dataset.boardInteractionBound = "true";
}

function ensureControlBindings() {
  if (document.body.dataset.controlBindingsBound) {
    return;
  }

  document.body.addEventListener("click", async (event) => {
    const drawButton = event.target.closest?.("#draw-card, [data-draw-card]");
    if (drawButton) {
      try {
        await api(`/api/games/${state.gameId}/draw-card`, {
          method: "POST",
          body: { playerId: state.playerId }
        });
        await refreshView();
        render();
      } catch (error) {
        window.alert(error.message);
      }
      return;
    }

    const endTurnButton = event.target.closest?.("#end-turn");
    if (endTurnButton) {
      try {
        await api(`/api/games/${state.gameId}/end-turn`, {
          method: "POST",
          body: { playerId: state.playerId }
        });
        await refreshView();
        render();
      } catch (error) {
        window.alert(error.message);
      }
    }
  });

  document.body.dataset.controlBindingsBound = "true";
}

function parseDragPayload(dataTransfer) {
  const raw = dataTransfer.getData("application/json") || dataTransfer.getData("text/plain");
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return { type: "hand", instanceId: raw };
  }

  return null;
}

function clearDragPayload() {
  state.dragPayload = null;
  pageBody.classList.remove("dragging-card");
  pageBody.classList.remove("drag-arming");
  clearDropHighlights();
  clearAttackHighlights();
  const ghost = document.querySelector(".drag-ghost");
  if (ghost) {
    ghost.remove();
  }
}

function isModalOpen() {
  return Boolean(modalHost.innerHTML.trim());
}

function clearDropHighlights() {
  for (const node of document.querySelectorAll(".board-zone.dropping")) {
    node.classList.remove("dropping");
  }
}

function highlightZone(zone) {
  clearDropHighlights();
  const zoneRoot = zone?.closest?.("[data-drop-zone]") || zone;
  if (!zoneRoot) {
    return;
  }
  zoneRoot.classList.add("dropping");
}

function getHighlightedZone() {
  return document.querySelector(".board-zone.dropping[data-drop-zone]");
}

function findRectTarget(elements, clientX, clientY, padding = 0) {
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    if (
      clientX >= rect.left - padding &&
      clientX <= rect.right + padding &&
      clientY >= rect.top - padding &&
      clientY <= rect.bottom + padding
    ) {
      return element;
    }
  }
  return null;
}

function clearAttackHighlights() {
  for (const node of document.querySelectorAll(".attacking")) {
    node.classList.remove("attacking");
  }
}

function highlightAttackTarget(target) {
  clearAttackHighlights();
  target.classList.add("attacking");
}

function activatePointerDrag(drag, clientX, clientY) {
  drag.active = true;
  state.dragPayload = drag.payload;
  pageBody.classList.add("dragging-card");
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.innerHTML = `<img src="${drag.previewSrc}" alt="" />`;
  document.body.append(ghost);
  updatePointerDragPosition(clientX, clientY);
}

function updatePointerDragPosition(clientX, clientY) {
  const ghost = document.querySelector(".drag-ghost");
  if (!ghost) {
    return;
  }
  ghost.style.transform = `translate(${clientX + 14}px, ${clientY + 14}px)`;
}

function updatePointerHighlightsForPosition(clientX, clientY, payload) {
  clearDropHighlights();
  clearAttackHighlights();

  if (payload.type === "board") {
    const attackTarget = findRectTarget(opponentBoard.querySelectorAll("[data-attack-target], [data-attack-direct]"), clientX, clientY);
    if (attackTarget) {
      highlightAttackTarget(attackTarget);
      return;
    }
  }

  const zone = findRectTarget(selfBoard.querySelectorAll("[data-drop-zone]"), clientX, clientY, 18);
  if (zone) {
    highlightZone(zone);
  }
}

async function finalizePointerDrop(clientX, clientY, payload) {
  if (isModalOpen()) {
    return;
  }

  if (payload.type === "board") {
    const attackTarget = findRectTarget(opponentBoard.querySelectorAll("[data-attack-target], [data-attack-direct]"), clientX, clientY);
    if (attackTarget) {
      const self = state.view.players.self;
      const opponent = state.view.players.opponent;
      try {
        const body = await buildAttackRequest(payload, attackTarget, self, opponent);
        if (!body) {
          return;
        }
        await api(`/api/games/${state.gameId}/attack`, {
          method: "POST",
          body: { playerId: state.playerId, ...body }
        });
        await refreshView();
        render();
      } catch (error) {
        window.alert(error.message);
      }
      return;
    }
  }

  const zone = findRectTarget(selfBoard.querySelectorAll("[data-drop-zone]"), clientX, clientY, 18) || getHighlightedZone();
  if (!zone || !selfBoard.contains(zone)) {
    return;
  }

  await finalizeDropToZone(zone, payload);
}

async function finalizeDropToZone(zone, payload) {
  if (payload.type === "board" && payload.zone === zone.dataset.dropZone) {
    return;
  }

  try {
    if (payload.type === "hand") {
      await api(`/api/games/${state.gameId}/play-card`, {
        method: "POST",
        body: { playerId: state.playerId, instanceId: payload.instanceId, zone: zone.dataset.dropZone }
      });
    } else if (payload.type === "board") {
      await api(`/api/games/${state.gameId}/move-card`, {
        method: "POST",
        body: { playerId: state.playerId, instanceId: payload.instanceId, zone: zone.dataset.dropZone }
      });
    }
    await refreshView();
    render();
  } catch (error) {
    window.alert(error.message);
  }
}

async function buildAttackRequest(dragPayload, target, self, opponent) {
  const attacker = findBoardCard(self.board, dragPayload.instanceId);
  if (!attacker) {
    throw new Error("Attacker is no longer on your board.");
  }

  const body = {
    attackerId: dragPayload.instanceId,
    target:
      target.dataset.attackDirect === "true"
        ? { type: "direct" }
        : { type: "unit", instanceId: target.dataset.targetId }
  };

  if (attacker.zone === "frontline") {
    const attackingReinforcer = await chooseOptionalReinforcer(
      "Choose an attacking reinforcer",
      readyBackliners(self.board, attacker.card.instanceId),
      {
        attacker: {
          id: attacker.card.instanceId,
          name: attacker.card.name,
          zone: attacker.zone,
          power: attacker.card.power,
          cardAssetPath: attacker.card.cardAssetPath
        }
      }
    );
    if (attackingReinforcer === "__cancel__") {
      return null;
    }
    if (attackingReinforcer) {
      body.attackingReinforcerId = attackingReinforcer;
    }
  }

  return body;
}

async function buildAbilityRequest(ability, self) {
  if (ability.type === "hydra-devour" || ability.type === "orc-marksmen") {
    const choices = self.board.frontline
      .concat(self.board.flank, self.board.backline)
      .filter((card) => String(card.cardType ?? "").toLowerCase().includes("goblin"))
      .map((card) => ({ id: card.instanceId, name: card.name, power: card.power }));
    const targetId = await chooseCardOption(ability.targetPrompt || "Choose a Goblin to destroy", choices, true);
    if (!targetId) {
      throw new Error("A Goblin target is required.");
    }
    return { targetId };
  }

  if (ability.type === "goblin-warchief") {
    const choices = self.board.frontline
      .concat(self.board.flank, self.board.backline)
      .filter((card) => String(card.cardType ?? "").toLowerCase().includes("goblin"))
      .map((card) => ({ id: card.instanceId, name: card.name, power: card.power }));
    const targetId = await chooseCardOption(ability.targetPrompt || "Choose a Goblin to support", choices, true);
    if (!targetId) {
      throw new Error("A Goblin target is required.");
    }
    return { targetId };
  }

  return {};
}

function readyBackliners(board, excludeId = null) {
  return (board.backline || [])
    .filter((card) => card.ready && card.instanceId !== excludeId)
    .map((card) => ({
      id: card.instanceId,
      name: card.name,
      power: card.power,
      cardAssetPath: card.cardAssetPath,
      zone: "backline"
    }));
}

function findBoardCard(board, instanceId) {
  for (const zone of ["frontline", "flank", "backline"]) {
    const card = board[zone]?.find((candidate) => candidate.instanceId === instanceId);
    if (card) {
      return { card, zone };
    }
  }
  return null;
}

function createModalHost() {
  const host = document.createElement("div");
  host.className = "modal-host";
  document.body.append(host);
  return host;
}

function chooseOptionalReinforcer(title, options, context = {}) {
  if (!options.length) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    modalHost.innerHTML = `
      <div class="modal-scrim">
        <div class="modal-card combat-modal">
          <h3>${title}</h3>
          <p>Select one ready backliner or continue without one.</p>
          ${
            context.attacker
              ? `
                <div class="combat-preview-grid single-column">
                  <section class="combat-preview-column">
                    <span class="combat-preview-label">Attacking</span>
                    <div class="combat-preview-stack">
                      ${renderCombatPreviewCard(context.attacker, "attacker")}
                    </div>
                  </section>
                </div>
              `
              : ""
          }
          <div class="modal-options combat-option-grid">
            ${options
              .map(
                (option) => renderCombatOptionCard(option, "data-choice")
              )
              .join("")}
          </div>
          <div class="modal-actions">
            <button class="primary" data-choice="">No Reinforcer</button>
            <button class="secondary" data-choice="__cancel__">Cancel Attack</button>
          </div>
        </div>
      </div>
    `;

    for (const button of modalHost.querySelectorAll("[data-choice]")) {
      button.onclick = () => {
        const choice = button.dataset.choice || null;
        modalHost.innerHTML = "";
        resolve(choice);
      };
    }
  });
}

function chooseCardOption(title, options, required = false) {
  if (!options.length) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    modalHost.innerHTML = `
      <div class="modal-scrim">
        <div class="modal-card">
          <h3>${title}</h3>
          <div class="modal-options">
            ${options
              .map(
                (option) => `
                  <button class="secondary modal-option" data-choice="${option.id}">
                    <strong>${option.name}</strong>
                    <span>${option.power} power</span>
                  </button>
                `
              )
              .join("")}
          </div>
          ${
            required
              ? ""
              : `
                <div class="modal-actions">
                  <button class="primary" data-choice="">Cancel</button>
                </div>
              `
          }
        </div>
      </div>
    `;

    for (const button of modalHost.querySelectorAll("[data-choice]")) {
      button.onclick = () => {
        const choice = button.dataset.choice || null;
        modalHost.innerHTML = "";
        resolve(choice);
      };
    }
  });
}

function chooseCardAction(cardName, ability) {
  const costCopy =
    ability.actionCost > 0
      ? `Costs ${ability.actionCost} action${ability.actionCost === 1 ? "" : "s"}`
      : "Costs no actions";
  const speedCopy =
    ability.kind === "support"
      ? `Support Action • Requires this unit to be ready in the backline • ${costCopy} • Unreadies this card`
      : ability.actionCost
        ? `Activated Ability • ${costCopy}`
        : "Free Ability • Costs no action and does not unready this card";
  return new Promise((resolve) => {
    modalHost.innerHTML = `
      <div class="modal-scrim">
        <div class="modal-card">
          <h3>${cardName}</h3>
          <p>Choose what you want to do with this card.</p>
          <div class="modal-options">
            <button class="secondary modal-option" data-card-action="use">
              <strong>${ability.label}</strong>
              <span>${speedCopy}</span>
            </button>
          </div>
          <div class="modal-actions">
            <button class="primary" data-card-action="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `;

    for (const button of modalHost.querySelectorAll("[data-card-action]")) {
      button.onclick = () => {
        const useAction = button.dataset.cardAction === "use";
        modalHost.innerHTML = "";
        resolve(useAction);
      };
    }
  });
}

function openGraveyardBrowser(cards, playableGraveyard, isSelf) {
  modalHost.innerHTML = `
    <div class="modal-scrim">
      <div class="modal-card graveyard-browser">
        <h3>${isSelf ? "Your Graveyard" : "Opponent Graveyard"}</h3>
        <div class="graveyard-browser-list">
          ${
            cards.length
              ? cards
                  .map(
                    (card) => `
                      <article class="graveyard-browser-card">
                        <img src="${card.cardAssetPath}" alt="${card.name}" />
                        <div class="graveyard-browser-copy">
                          <strong>${card.name}</strong>
                          <span>${card.power} power</span>
                        </div>
                        ${
                          isSelf && playableGraveyard.has(card.instanceId)
                            ? `
                              <div class="graveyard-actions">
                                <button class="secondary graveyard-play" data-play-graveyard="${card.instanceId}" data-zone="frontline">Front</button>
                                <button class="secondary graveyard-play" data-play-graveyard="${card.instanceId}" data-zone="flank">Flank</button>
                                <button class="secondary graveyard-play" data-play-graveyard="${card.instanceId}" data-zone="backline">Back</button>
                              </div>
                            `
                            : ""
                        }
                      </article>
                    `
                  )
                  .join("")
              : `<div class="graveyard-empty">No cards here</div>`
          }
        </div>
        <div class="modal-actions">
          <button class="primary" data-close-graveyard="true">Close</button>
        </div>
      </div>
    </div>
  `;

  for (const button of modalHost.querySelectorAll("[data-play-graveyard]")) {
    button.onclick = async () => {
      try {
        await api(`/api/games/${state.gameId}/play-from-graveyard`, {
          method: "POST",
          body: {
            playerId: state.playerId,
            instanceId: button.dataset.playGraveyard,
            zone: button.dataset.zone
          }
        });
        await refreshView();
        modalHost.innerHTML = "";
        render();
      } catch (error) {
        window.alert(error.message);
      }
    };
  }

  const closeButton = modalHost.querySelector("[data-close-graveyard]");
  if (closeButton) {
    closeButton.onclick = () => {
      modalHost.innerHTML = "";
    };
  }
}

async function createGame() {
  const created = await api("/api/games", { method: "POST" });
  updateUrl(created.gameId, created.hostPlayerId);
  state.guestToken = created.guestToken;
  await refreshView();
  render();
}

async function refreshView() {
  const nextView = await api(`/api/games/${state.gameId}?player=${state.playerId}`);
  const nextHash = JSON.stringify(nextView);
  const changed = nextHash !== state.viewHash;
  state.view = nextView;
  state.viewHash = nextHash;
  return changed;
}

function updateUrl(gameId, playerId) {
  state.gameId = gameId;
  state.playerId = playerId;
  const url = new URL(window.location.href);
  url.searchParams.set("game", gameId);
  url.searchParams.set("player", playerId);
  url.searchParams.delete("join");
  window.history.replaceState({}, "", url);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: { "content-type": "application/json" },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: "Request failed" }));
    throw new Error(payload.error || "Request failed");
  }

  return response.json();
}
