// Wordles - GitHub Pages Wordle Clone Game Logic

(function () {
  "use strict";

  // --- Constants & Config ---
  const DEFAULT_LENGTH = 5;
  const DEFAULT_GUESSES = 6;
  const STORAGE_PREFIX = "wordles_log_";
  const THEME_KEY = "wordles_theme";
  const HARD_MODE_KEY = "wordles_hard_mode";

  // --- State Variables ---
  let currentMode = "wordle";
  let wordLength = DEFAULT_LENGTH;
  let maxGuesses = DEFAULT_GUESSES;
  let puzzleDate = getTodayDateString();
  let puzzleNumber = 1;
  let isCustom = false;
  let targetWord = "";
  let customCipher = "";
  let isHardMode = localStorage.getItem(HARD_MODE_KEY) === "true";

  let guesses = [];
  let currentGuess = "";
  let isGameOver = false;
  let gameWon = false;
  let keyStates = {}; // char -> 'correct' | 'present' | 'absent'
  let isRevealing = false;

  // --- Utility: Date & PRNG ---
  function getTodayDateString() {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function hashString(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function selectTargetWord(dateStr, num, len) {
    const list = (WORD_LISTS && WORD_LISTS.targets && WORD_LISTS.targets[len]) || WORD_LISTS.targets[5];
    const seed = hashString(`${dateStr}#${num}-len${len}`);
    const rng = mulberry32(seed);
    const index = Math.floor(rng() * list.length);
    return list[index];
  }

  function getOrdinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // --- Custom Word Encryption / Decryption ---
  const CIPHER_SALT = 0x6e;

  function encryptCustomWord(word, tries) {
    const clean = word.toUpperCase().trim();
    const len = clean.length;
    const bytes = [];
    bytes.push(len ^ 0x3c);
    bytes.push(tries ^ 0x5a);

    let rollingKey = CIPHER_SALT;
    for (let i = 0; i < len; i++) {
      const code = clean.charCodeAt(i);
      const enc = (code ^ rollingKey) & 0xff;
      bytes.push(enc);
      rollingKey = (rollingKey * 37 + (i + 1) * 13) & 0xff;
    }

    const binary = String.fromCharCode(...bytes);
    const b64 = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return b64;
  }

  function decryptCustomWord(token) {
    try {
      let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4 !== 0) {
        b64 += "=";
      }
      const binary = atob(b64);
      if (binary.length < 3) return null;

      const len = binary.charCodeAt(0) ^ 0x3c;
      const tries = binary.charCodeAt(1) ^ 0x5a;

      if (len < 3 || len > 7 || tries < 2 || tries > 8) return null;
      if (binary.length !== len + 2) return null;

      let chars = "";
      let rollingKey = CIPHER_SALT;
      for (let i = 0; i < len; i++) {
        const enc = binary.charCodeAt(i + 2);
        const dec = (enc ^ rollingKey) & 0xff;
        chars += String.fromCharCode(dec);
        rollingKey = (rollingKey * 37 + (i + 1) * 13) & 0xff;
      }

      if (!/^[A-Z]+$/.test(chars)) return null;

      return { word: chars, length: len, tries: tries };
    } catch (e) {
      return null;
    }
  }

  // --- Evaluation Logic ---
  function evaluateGuess(guess, target) {
    const len = target.length;
    const result = new Array(len).fill("absent");
    const targetCounts = {};

    // Pass 1: exact matches (Green)
    for (let i = 0; i < len; i++) {
      const gChar = guess[i];
      const tChar = target[i];
      if (gChar === tChar) {
        result[i] = "correct";
      } else {
        targetCounts[tChar] = (targetCounts[tChar] || 0) + 1;
      }
    }

    // Pass 2: misplaced matches (Yellow)
    for (let i = 0; i < len; i++) {
      if (result[i] !== "correct") {
        const gChar = guess[i];
        if (targetCounts[gChar] && targetCounts[gChar] > 0) {
          result[i] = "present";
          targetCounts[gChar]--;
        } else {
          result[i] = "absent";
        }
      }
    }

    return result;
  }

  // Hard Mode Validator
  function validateHardMode(newGuess, prevGuesses, target) {
    for (let r = 0; r < prevGuesses.length; r++) {
      const prev = prevGuesses[r];
      const evals = evaluateGuess(prev, target);

      // 1. Exact matches (green) must be used in the same position
      for (let i = 0; i < prev.length; i++) {
        if (evals[i] === "correct") {
          if (newGuess[i] !== prev[i]) {
            return {
              valid: false,
              message: `${getOrdinal(i + 1)} letter must be ${prev[i]}`,
            };
          }
        }
      }

      // 2. Confirmed present letters (yellow & green) must be in new guess
      const requiredCounts = {};
      for (let i = 0; i < prev.length; i++) {
        if (evals[i] === "correct" || evals[i] === "present") {
          const char = prev[i];
          requiredCounts[char] = (requiredCounts[char] || 0) + 1;
        }
      }

      const newCounts = {};
      for (let i = 0; i < newGuess.length; i++) {
        const char = newGuess[i];
        newCounts[char] = (newCounts[char] || 0) + 1;
      }

      for (const char in requiredCounts) {
        if ((newCounts[char] || 0) < requiredCounts[char]) {
          return {
            valid: false,
            message: `Guess must contain ${char}`,
          };
        }
      }
    }

    return { valid: true };
  }

  function getEmojiRow(evaluations) {
    return evaluations
      .map((st) => {
        if (st === "correct") return "🟩";
        if (st === "present") return "🟨";
        return "⬛";
      })
      .join("");
  }

  function getEmojiGrid() {
    return guesses
      .map((guess) => {
        const evals = evaluateGuess(guess, targetWord);
        return getEmojiRow(evals);
      })
      .join("\n");
  }

  // --- Game Persistence & Logging ---
  function getModeLogKey(mode) {
    return `${STORAGE_PREFIX}${mode}`;
  }

  function loadGameLogs(mode) {
    try {
      const raw = localStorage.getItem(getModeLogKey(mode));
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveGameLog(logEntry) {
    const logs = loadGameLogs(currentMode);
    const existingIndex = logs.findIndex((item) => item.id === logEntry.id);
    if (existingIndex >= 0) {
      logs[existingIndex] = logEntry;
    } else {
      logs.unshift(logEntry);
    }
    try {
      localStorage.setItem(getModeLogKey(currentMode), JSON.stringify(logs));
    } catch (e) {
      console.warn("Unable to save log to localStorage", e);
    }
  }

  function createLogEntry() {
    const gameId = isCustom
      ? `custom-${customCipher}-L${wordLength}-G${maxGuesses}${isHardMode ? "-H" : ""}`
      : `${puzzleDate}#${puzzleNumber}-L${wordLength}-G${maxGuesses}${isHardMode ? "-H" : ""}`;

    const evals = guesses.map((g) => evaluateGuess(g, targetWord));

    return {
      id: gameId,
      mode: currentMode,
      hardMode: isHardMode,
      date: puzzleDate,
      puzzleNumber: isCustom ? null : puzzleNumber,
      wordLength: wordLength,
      maxGuesses: maxGuesses,
      isCustom: isCustom,
      targetWord: targetWord,
      guesses: [...guesses],
      evaluations: evals,
      emojiGrid: getEmojiGrid(),
      won: gameWon,
      moves: guesses.length,
      timestamp: new Date().toISOString(),
    };
  }

  // --- UI Elements ---
  const boardEl = document.getElementById("board");
  const keyboardEl = document.getElementById("keyboard");
  const modeSelectEl = document.getElementById("mode-select");
  const lengthPillsEl = document.getElementById("length-pills");
  const guessPillsEl = document.getElementById("guess-pills");
  const puzzleBadgeEl = document.getElementById("puzzle-badge");
  const toastContainerEl = document.getElementById("toast-container");
  const themeToggleBtn = document.getElementById("theme-toggle-btn");
  const hardModeCheckbox = document.getElementById("hard-mode-checkbox");
  const hardModeWrap = document.getElementById("hard-mode-wrap");

  // Modals
  const resultModalOverlay = document.getElementById("result-modal-overlay");
  const customModalOverlay = document.getElementById("custom-modal-overlay");
  const historyModalOverlay = document.getElementById("history-modal-overlay");

  // --- Toast Manager ---
  function showToast(message, duration = 2000) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    toastContainerEl.appendChild(toast);
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, duration + 200);
  }

  // --- Theme Management ---
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light") {
      document.body.classList.add("light-theme");
      themeToggleBtn.innerHTML = "&#9790;";
      themeToggleBtn.title = "Switch to Dark Theme";
    } else {
      document.body.classList.remove("light-theme");
      themeToggleBtn.innerHTML = "&#9728;";
      themeToggleBtn.title = "Switch to Light Theme";
    }
  }

  function toggleTheme() {
    const isLight = document.body.classList.toggle("light-theme");
    localStorage.setItem(THEME_KEY, isLight ? "light" : "dark");
    if (isLight) {
      themeToggleBtn.innerHTML = "&#9790;";
      themeToggleBtn.title = "Switch to Dark Theme";
    } else {
      themeToggleBtn.innerHTML = "&#9728;";
      themeToggleBtn.title = "Switch to Light Theme";
    }
  }

  // --- URL State Synchronization ---
  function updateURL() {
    const url = new URL(window.location.href);
    url.search = "";

    if (isCustom) {
      url.searchParams.set("c", customCipher);
      if (maxGuesses !== DEFAULT_GUESSES) {
        url.searchParams.set("tries", maxGuesses);
      }
    } else {
      url.searchParams.set("d", puzzleDate);
      url.searchParams.set("n", puzzleNumber);
      if (wordLength !== DEFAULT_LENGTH) {
        url.searchParams.set("len", wordLength);
      }
      if (maxGuesses !== DEFAULT_GUESSES) {
        url.searchParams.set("tries", maxGuesses);
      }
    }

    if (currentMode !== "wordle") {
      url.searchParams.set("mode", currentMode);
    }

    window.history.replaceState({}, "", url.toString());
  }

  function parseURLParams() {
    const params = new URLSearchParams(window.location.search);

    if (params.has("mode")) {
      currentMode = params.get("mode");
      if (modeSelectEl) modeSelectEl.value = currentMode;
    }

    if (params.has("c")) {
      const token = params.get("c");
      const dec = decryptCustomWord(token);
      if (dec) {
        isCustom = true;
        customCipher = token;
        targetWord = dec.word;
        wordLength = dec.length;
        maxGuesses = params.has("tries") ? parseInt(params.get("tries"), 10) : dec.tries;
        return;
      }
    }

    isCustom = false;
    if (params.has("d")) {
      const d = params.get("d");
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        puzzleDate = d;
      }
    }

    if (params.has("n")) {
      const n = parseInt(params.get("n"), 10);
      if (!isNaN(n) && n > 0) {
        puzzleNumber = n;
      }
    }

    if (params.has("len")) {
      const l = parseInt(params.get("len"), 10);
      if (l >= 3 && l <= 7) {
        wordLength = l;
      }
    }

    if (params.has("tries")) {
      const t = parseInt(params.get("tries"), 10);
      if (t >= 2 && t <= 8) {
        maxGuesses = t;
      }
    }

    targetWord = selectTargetWord(puzzleDate, puzzleNumber, wordLength);
  }

  // --- Board & Keyboard Rendering ---
  function renderBoard() {
    boardEl.innerHTML = "";
    boardEl.setAttribute("data-len", wordLength);

    for (let r = 0; r < maxGuesses; r++) {
      const rowEl = document.createElement("div");
      rowEl.className = "row";
      rowEl.id = `row-${r}`;

      const guess = guesses[r] || (r === guesses.length ? currentGuess : "");
      const isCommitted = r < guesses.length;
      const evaluations = isCommitted ? evaluateGuess(guess, targetWord) : null;

      for (let c = 0; c < wordLength; c++) {
        const tile = document.createElement("div");
        tile.className = "tile";
        tile.id = `tile-${r}-${c}`;

        const char = guess[c] || "";
        tile.textContent = char;

        if (isCommitted) {
          const evalState = evaluations[c];
          tile.setAttribute("data-state", evalState);
        } else if (char) {
          tile.setAttribute("data-state", "active");
        }

        rowEl.appendChild(tile);
      }

      boardEl.appendChild(rowEl);
    }

    updateControlsUI();
  }

  function renderKeyboard() {
    keyboardEl.innerHTML = "";
    const rows = [
      ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
      ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
      ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "⌫"],
    ];

    rows.forEach((row) => {
      const rowEl = document.createElement("div");
      rowEl.className = "keyboard-row";

      row.forEach((key) => {
        const btn = document.createElement("button");
        btn.className = "key";
        btn.textContent = key;
        btn.setAttribute("data-key", key);

        if (key === "ENTER" || key === "⌫") {
          btn.classList.add("large");
        }

        const state = keyStates[key];
        if (state) {
          btn.setAttribute("data-state", state);
        }

        btn.addEventListener("click", () => handleVirtualKeyPress(key));
        rowEl.appendChild(btn);
      });

      keyboardEl.appendChild(rowEl);
    });
  }

  function updateControlsUI() {
    // Update length pills
    const lenBtns = lengthPillsEl.querySelectorAll(".pill-btn");
    lenBtns.forEach((btn) => {
      const val = parseInt(btn.getAttribute("data-len"), 10);
      btn.classList.toggle("active", val === wordLength);
    });

    // Update guess pills
    const guessBtns = guessPillsEl.querySelectorAll(".pill-btn");
    guessBtns.forEach((btn) => {
      const val = parseInt(btn.getAttribute("data-tries"), 10);
      btn.classList.toggle("active", val === maxGuesses);
    });

    // Update puzzle badge
    const star = isHardMode ? "*" : "";
    if (isCustom) {
      puzzleBadgeEl.textContent = `Custom (${wordLength}L)${star}`;
    } else {
      puzzleBadgeEl.textContent = `${puzzleDate} #${puzzleNumber}${star}`;
    }

    // Hard mode toggle state
    if (hardModeCheckbox) {
      hardModeCheckbox.checked = isHardMode;
      const gameInProgress = guesses.length > 0;
      hardModeCheckbox.disabled = gameInProgress;
      if (hardModeWrap) {
        hardModeWrap.classList.toggle("disabled", gameInProgress);
      }
    }
  }

  function recalculateKeyStates() {
    keyStates = {};
    for (let r = 0; r < guesses.length; r++) {
      const guess = guesses[r];
      const evals = evaluateGuess(guess, targetWord);
      for (let c = 0; c < guess.length; c++) {
        const char = guess[c];
        const state = evals[c];
        const current = keyStates[char];
        if (state === "correct") {
          keyStates[char] = "correct";
        } else if (state === "present" && current !== "correct") {
          keyStates[char] = "present";
        } else if (state === "absent" && !current) {
          keyStates[char] = "absent";
        }
      }
    }
    renderKeyboard();
  }

  // --- Game Flow & Interactions ---
  function startNewGame() {
    guesses = [];
    currentGuess = "";
    isGameOver = false;
    gameWon = false;
    keyStates = {};
    isRevealing = false;

    if (!isCustom) {
      targetWord = selectTargetWord(puzzleDate, puzzleNumber, wordLength);
    }

    if (hardModeCheckbox) {
      hardModeCheckbox.checked = isHardMode;
      hardModeCheckbox.disabled = false;
      if (hardModeWrap) hardModeWrap.classList.remove("disabled");
    }

    updateURL();
    renderBoard();
    renderKeyboard();
  }

  function addLetter(letter) {
    if (isGameOver || isRevealing) return;
    if (currentGuess.length < wordLength) {
      currentGuess += letter.toUpperCase();
      updateCurrentRow();
    }
  }

  function deleteLetter() {
    if (isGameOver || isRevealing) return;
    if (currentGuess.length > 0) {
      currentGuess = currentGuess.slice(0, -1);
      updateCurrentRow();
    }
  }

  function updateCurrentRow() {
    const rowIdx = guesses.length;
    for (let c = 0; c < wordLength; c++) {
      const tile = document.getElementById(`tile-${rowIdx}-${c}`);
      if (tile) {
        const char = currentGuess[c] || "";
        tile.textContent = char;
        if (char) {
          tile.setAttribute("data-state", "active");
        } else {
          tile.removeAttribute("data-state");
        }
      }
    }
  }

  function submitGuess() {
    if (isGameOver || isRevealing) return;

    if (currentGuess.length !== wordLength) {
      showToast("Not enough letters");
      shakeRow(guesses.length);
      return;
    }

    if (!isValidWord(currentGuess, wordLength, isCustom)) {
      showToast("Not in word list");
      shakeRow(guesses.length);
      return;
    }

    // Hard Mode Check
    if (isHardMode && guesses.length > 0) {
      const hardCheck = validateHardMode(currentGuess, guesses, targetWord);
      if (!hardCheck.valid) {
        showToast(hardCheck.message);
        shakeRow(guesses.length);
        return;
      }
    }

    const rowIdx = guesses.length;
    const guessToReveal = currentGuess;
    const evaluations = evaluateGuess(guessToReveal, targetWord);

    isRevealing = true;
    guesses.push(guessToReveal);
    currentGuess = "";

    // Lock hard mode toggle during the game
    if (hardModeCheckbox) {
      hardModeCheckbox.disabled = true;
      if (hardModeWrap) hardModeWrap.classList.add("disabled");
    }

    // Animate tile flips sequentially
    for (let c = 0; c < wordLength; c++) {
      const tile = document.getElementById(`tile-${rowIdx}-${c}`);
      const evalState = evaluations[c];

      setTimeout(() => {
        tile.classList.add("flip-in");

        setTimeout(() => {
          tile.setAttribute("data-state", evalState);
          tile.classList.remove("flip-in");
          tile.classList.add("flip-out");

          setTimeout(() => {
            tile.classList.remove("flip-out");
          }, 250);
        }, 250);
      }, c * 250);
    }

    const totalRevealTime = wordLength * 250 + 300;
    setTimeout(() => {
      isRevealing = false;
      recalculateKeyStates();

      if (guessToReveal === targetWord) {
        isGameOver = true;
        gameWon = true;
        bounceRow(rowIdx);
        saveGameLog(createLogEntry());
        setTimeout(() => openResultModal(true), 1200);
      } else if (guesses.length >= maxGuesses) {
        isGameOver = true;
        gameWon = false;
        saveGameLog(createLogEntry());
        setTimeout(() => openResultModal(false), 1000);
      }
    }, totalRevealTime);
  }

  function shakeRow(rowIdx) {
    const rowEl = document.getElementById(`row-${rowIdx}`);
    if (rowEl) {
      rowEl.classList.remove("shake");
      void rowEl.offsetWidth;
      rowEl.classList.add("shake");
    }
  }

  function bounceRow(rowIdx) {
    const rowEl = document.getElementById(`row-${rowIdx}`);
    if (rowEl) {
      for (let c = 0; c < wordLength; c++) {
        const tile = document.getElementById(`tile-${rowIdx}-${c}`);
        if (tile) {
          setTimeout(() => {
            tile.classList.add("bounce");
          }, c * 100);
        }
      }
    }
  }

  // --- Keyboard Event Handling ---
  function handleVirtualKeyPress(key) {
    if (key === "ENTER") {
      submitGuess();
    } else if (key === "⌫" || key === "BACKSPACE") {
      deleteLetter();
    } else if (/^[A-Z]$/i.test(key)) {
      addLetter(key);
    }
  }

  function handlePhysicalKeyDown(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.tagName === "SELECT") {
      return;
    }

    if (isAnyModalOpen()) {
      if (e.key === "Escape") {
        closeAllModals();
      }
      return;
    }

    if (e.key === "Enter") {
      submitGuess();
    } else if (e.key === "Backspace") {
      deleteLetter();
    } else if (/^[a-zA-Z]$/.test(e.key)) {
      addLetter(e.key);
    }
  }

  // --- Sharing & Clipboard Format ---
  function generateShareText(won, moveCount) {
    const star = isHardMode ? "*" : "";
    const scoreStr = won ? `${moveCount}/${maxGuesses}${star}` : `X/${maxGuesses}${star}`;
    const header = isCustom
      ? `Wordles Custom (${wordLength} letters, ${scoreStr})`
      : `Wordles ${puzzleDate} #${puzzleNumber}${star} (${wordLength} letters, ${scoreStr})`;

    const grid = getEmojiGrid();
    const link = window.location.href;

    return `${header}\n${grid}\n${link}`;
  }

  function generatePreGameShareLink() {
    return window.location.href;
  }

  async function copyToClipboard(text, successMsg = "Copied to clipboard!") {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMsg);
    } catch (err) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      showToast(successMsg);
    }
  }

  // --- Modals Management ---
  function isAnyModalOpen() {
    return (
      resultModalOverlay.classList.contains("open") ||
      customModalOverlay.classList.contains("open") ||
      historyModalOverlay.classList.contains("open")
    );
  }

  function closeAllModals() {
    resultModalOverlay.classList.remove("open");
    customModalOverlay.classList.remove("open");
    historyModalOverlay.classList.remove("open");
  }

  // Result Modal
  function openResultModal(won) {
    const titleEl = document.getElementById("result-title");
    const subEl = document.getElementById("result-subtitle");
    const revealEl = document.getElementById("secret-word-display");
    const previewEl = document.getElementById("result-emoji-preview");

    if (won) {
      titleEl.textContent = "Splendid!";
      subEl.textContent = `You solved it in ${guesses.length} / ${maxGuesses} guesses.`;
    } else {
      titleEl.textContent = "Game Over";
      subEl.textContent = "Better luck on the next one!";
    }

    revealEl.textContent = targetWord;
    previewEl.textContent = getEmojiGrid();

    resultModalOverlay.classList.add("open");
  }

  // Custom Creation Modal
  function openCustomModal() {
    const wordInput = document.getElementById("custom-word-input");
    const triesSelect = document.getElementById("custom-tries-select");
    const linkInput = document.getElementById("custom-link-output");

    wordInput.value = "";
    triesSelect.value = "6";
    linkInput.value = "";

    customModalOverlay.classList.add("open");
  }

  function updateCustomLinkGenerator() {
    const wordInput = document.getElementById("custom-word-input");
    const triesSelect = document.getElementById("custom-tries-select");
    const linkInput = document.getElementById("custom-link-output");

    const rawWord = wordInput.value.toUpperCase().replace(/[^A-Z]/g, "");
    wordInput.value = rawWord;

    if (rawWord.length >= 3 && rawWord.length <= 7) {
      const tries = parseInt(triesSelect.value, 10);
      const cipher = encryptCustomWord(rawWord, tries);
      const url = new URL(window.location.origin + window.location.pathname);
      url.searchParams.set("c", cipher);
      if (tries !== DEFAULT_GUESSES) {
        url.searchParams.set("tries", tries);
      }
      linkInput.value = url.toString();
    } else {
      linkInput.value = "";
    }
  }

  // History / Logs Modal
  function openHistoryModal() {
    const logs = loadGameLogs(currentMode);

    const totalPlayed = logs.length;
    const wins = logs.filter((l) => l.won).length;
    const winPct = totalPlayed > 0 ? Math.round((wins / totalPlayed) * 100) : 0;

    let currentStreak = 0;
    let maxStreak = 0;
    let tempStreak = 0;

    for (let i = logs.length - 1; i >= 0; i--) {
      if (logs[i].won) {
        tempStreak++;
        if (tempStreak > maxStreak) maxStreak = tempStreak;
      } else {
        tempStreak = 0;
      }
    }
    for (let i = 0; i < logs.length; i++) {
      if (logs[i].won) {
        currentStreak++;
      } else {
        break;
      }
    }

    document.getElementById("stat-played").textContent = totalPlayed;
    document.getElementById("stat-win-pct").textContent = `${winPct}%`;
    document.getElementById("stat-current-streak").textContent = currentStreak;
    document.getElementById("stat-max-streak").textContent = maxStreak;

    const listEl = document.getElementById("history-items-list");
    listEl.innerHTML = "";

    if (logs.length === 0) {
      listEl.innerHTML = `<div style="text-align:center; padding: 20px; color: var(--text-muted); font-size:13px;">No games logged yet in ${currentMode} mode.</div>`;
    } else {
      logs.forEach((log) => {
        const item = document.createElement("div");
        item.className = "history-item";

        const info = document.createElement("div");
        info.className = "history-info";

        const title = document.createElement("div");
        title.className = "history-title";
        const hardTag = log.hardMode ? ` <span class="hard-mode-tag">★ Hard</span>` : "";
        title.innerHTML = (log.isCustom
          ? `Custom (${log.wordLength} letters)`
          : `${log.date} #${log.puzzleNumber} (${log.wordLength}L)`) + hardTag;

        const sub = document.createElement("div");
        sub.className = "history-sub";
        const dateFormatted = new Date(log.timestamp).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        sub.textContent = `${log.targetWord} • ${dateFormatted}`;

        info.appendChild(title);
        info.appendChild(sub);

        const badge = document.createElement("div");
        badge.className = `history-badge ${log.won ? "win" : "loss"}`;
        const star = log.hardMode ? "*" : "";
        badge.textContent = log.won ? `${log.moves}/${log.maxGuesses}${star}` : `X/${log.maxGuesses}${star}`;

        item.appendChild(info);
        item.appendChild(badge);

        item.style.cursor = "pointer";
        item.title = "Click to copy game result";
        item.addEventListener("click", () => {
          const star = log.hardMode ? "*" : "";
          const scoreStr = log.won ? `${log.moves}/${log.maxGuesses}${star}` : `X/${log.maxGuesses}${star}`;
          const head = log.isCustom
            ? `Wordles Custom (${log.wordLength} letters, ${scoreStr})`
            : `Wordles ${log.date} #${log.puzzleNumber}${star} (${log.wordLength} letters, ${scoreStr})`;
          copyToClipboard(`${head}\n${log.emojiGrid}`, "Copied past result to clipboard!");
        });

        listEl.appendChild(item);
      });
    }

    historyModalOverlay.classList.add("open");
  }

  function downloadLogAsJSON() {
    const logs = loadGameLogs(currentMode);
    const dataStr = JSON.stringify(logs, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Wordles_Log_${currentMode}_${getTodayDateString()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Downloaded log file");
  }

  // --- Event Setup & Initialization ---
  function setupEventListeners() {
    // Physical keyboard
    window.addEventListener("keydown", handlePhysicalKeyDown);

    // Theme toggle
    themeToggleBtn.addEventListener("click", toggleTheme);

    // Hard Mode Checkbox
    if (hardModeCheckbox) {
      hardModeCheckbox.addEventListener("change", (e) => {
        if (guesses.length > 0) {
          e.preventDefault();
          hardModeCheckbox.checked = isHardMode;
          showToast("Hard mode cannot be disabled mid-game");
          return;
        }
        isHardMode = e.target.checked;
        localStorage.setItem(HARD_MODE_KEY, isHardMode ? "true" : "false");
        updateControlsUI();
      });
    }

    // Length pills
    lengthPillsEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("pill-btn")) {
        const newLen = parseInt(e.target.getAttribute("data-len"), 10);
        if (newLen !== wordLength) {
          wordLength = newLen;
          isCustom = false;
          startNewGame();
        }
      }
    });

    // Guess count pills
    guessPillsEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("pill-btn")) {
        const newTries = parseInt(e.target.getAttribute("data-tries"), 10);
        if (newTries !== maxGuesses) {
          maxGuesses = newTries;
          startNewGame();
        }
      }
    });

    // Navigation buttons
    document.getElementById("btn-prev-puzzle").addEventListener("click", () => {
      if (puzzleNumber > 1) {
        puzzleNumber--;
        isCustom = false;
        startNewGame();
      }
    });

    document.getElementById("btn-next-puzzle").addEventListener("click", () => {
      puzzleNumber++;
      isCustom = false;
      startNewGame();
    });

    document.getElementById("btn-random-puzzle").addEventListener("click", () => {
      puzzleNumber = Math.floor(Math.random() * 500) + 1;
      isCustom = false;
      startNewGame();
    });

    // Pre-game share link
    document.getElementById("btn-share-seed").addEventListener("click", () => {
      copyToClipboard(generatePreGameShareLink(), "Copied puzzle link to clipboard!");
    });

    // Mode Selector
    modeSelectEl.addEventListener("change", (e) => {
      currentMode = e.target.value;
      startNewGame();
    });

    // Custom Word Modal Controls
    document.getElementById("btn-open-custom").addEventListener("click", openCustomModal);
    document.getElementById("custom-modal-close").addEventListener("click", closeAllModals);
    document.getElementById("custom-word-input").addEventListener("input", updateCustomLinkGenerator);
    document.getElementById("custom-tries-select").addEventListener("change", updateCustomLinkGenerator);

    document.getElementById("btn-copy-custom-link").addEventListener("click", () => {
      const link = document.getElementById("custom-link-output").value;
      if (link) {
        copyToClipboard(link, "Copied custom puzzle link!");
      } else {
        showToast("Enter a 3-7 letter word first");
      }
    });

    document.getElementById("btn-play-custom").addEventListener("click", () => {
      const link = document.getElementById("custom-link-output").value;
      if (link) {
        window.location.href = link;
      } else {
        showToast("Enter a 3-7 letter word first");
      }
    });

    // History Modal Controls
    document.getElementById("btn-open-history").addEventListener("click", openHistoryModal);
    document.getElementById("history-modal-close").addEventListener("click", closeAllModals);
    document.getElementById("btn-download-json").addEventListener("click", downloadLogAsJSON);

    // Result Modal Controls
    document.getElementById("result-modal-close").addEventListener("click", closeAllModals);
    document.getElementById("btn-copy-result").addEventListener("click", () => {
      const shareText = generateShareText(gameWon, guesses.length);
      copyToClipboard(shareText, "Copied result to clipboard!");
    });

    document.getElementById("btn-result-next").addEventListener("click", () => {
      closeAllModals();
      puzzleNumber++;
      isCustom = false;
      startNewGame();
    });

    // Close modals on overlay background click
    [resultModalOverlay, customModalOverlay, historyModalOverlay].forEach((overlay) => {
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) {
          closeAllModals();
        }
      });
    });
  }

  // --- App Startup ---
  function init() {
    initTheme();
    parseURLParams();
    setupEventListeners();
    startNewGame();
  }

  // Run on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
