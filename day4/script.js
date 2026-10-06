// Select the elements before attaching their event listeners.
const noteText = document.querySelector("#note-text");
const charCount = document.querySelector("#char-count");
const wordCount = document.querySelector("#word-count");
const clearButton = document.querySelector("#clear-btn");
const themeToggle = document.querySelector("#theme-toggle");

const DRAFT_KEY = "quicknotes-draft";
const THEME_KEY = "quicknotes-theme";
const CHARACTER_LIMIT = 200;
const WARNING_LIMIT = 180;

function updateCounts() {
  const characters = noteText.value.length;
  const trimmedText = noteText.value.trim();
  // Spaces, tabs and line breaks separate words. Empty text has no words.
  const words = trimmedText === "" ? 0 : trimmedText.split(/\s+/).length;

  charCount.textContent = `${characters} / ${CHARACTER_LIMIT} characters`;
  wordCount.textContent = `${words} words`;
  charCount.classList.toggle("warning", characters > WARNING_LIMIT);
  charCount.classList.toggle("over", characters > CHARACTER_LIMIT);
}

function clearDraft() {
  noteText.value = "";
  localStorage.removeItem(DRAFT_KEY);
  updateCounts();
  noteText.focus();
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("dark", isDark);
  // The label describes the theme the button will switch to.
  themeToggle.textContent = isDark ? "Light mode" : "Dark mode";
}

noteText.addEventListener("input", () => {
  updateCounts();
  localStorage.setItem(DRAFT_KEY, noteText.value);
});

clearButton.addEventListener("click", clearDraft);

// Escape only clears the draft when the textarea receives the key press.
noteText.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    clearDraft();
  }
});

themeToggle.addEventListener("click", () => {
  const nextTheme = document.body.classList.contains("dark") ? "light" : "dark";
  applyTheme(nextTheme);
  localStorage.setItem(THEME_KEY, nextTheme);
});

// Restore both saved choices, then draw the counters once on page load.
noteText.value = localStorage.getItem(DRAFT_KEY) || "";
applyTheme(localStorage.getItem(THEME_KEY) || "light");
updateCounts();
