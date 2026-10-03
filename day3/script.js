let notes = [
  { id: 1, text: "Buy milk and bread", category: "personal" },
  { id: 2, text: "Finish the Day 3 assignment", category: "study" },
  { id: 3, text: "Email the project report to Grace", category: "work" },
  { id: 4, text: "Revise JavaScript arrays", category: "study" },
  { id: 5, text: "Call mum", category: "personal" },
];

// Return every note containing the word, regardless of letter case.
function searchNotes(word) {
  return notes.filter((note) =>
    note.text.toLowerCase().includes(word.toLowerCase()),
  );
}

function longestNote() {
  if (notes.length === 0) {
    return null;
  }

  let longest = notes[0];

  for (const note of notes) {
    if (note.text.length > longest.text.length) {
      longest = note;
    }
  }

  return longest;
}

function countByCategory() {
  const counts = {};

  for (const note of notes) {
    counts[note.category] = (counts[note.category] || 0) + 1;
  }

  return counts;
}

function getSummary() {
  const counts = countByCategory();
  const noun = notes.length === 1 ? "note" : "notes";
  const parts = [];

  // Keep the category order consistent in the summary.
  for (const category of ["personal", "work", "study"]) {
    if (counts[category]) {
      parts.push(`${counts[category]} ${category}`);
    }
  }

  if (notes.length === 0) {
    return "0 notes.";
  }

  return `${notes.length} ${noun}: ${parts.join(", ")}.`;
}

function isDuplicate(text) {
  // Trim outer spaces and collapse repeated spaces between words.
  const normalizedText = text.trim().toLowerCase().replace(/\s+/g, " ");

  return notes.some(
    (note) =>
      note.text.trim().toLowerCase().replace(/\s+/g, " ") === normalizedText,
  );
}

function addNote(text, category) {
  if (typeof text !== "string") {
    console.log("Not added: note text must be a string.");
    return false;
  }

  // Validate and store the text after removing outer spaces.
  const trimmedText = text.trim();

  if (trimmedText.length < 1 || trimmedText.length > 200) {
    console.log("Not added: note text must be 1–200 characters.");
    return false;
  }

  if (!["personal", "work", "study"].includes(category)) {
    console.log("Not added: category must be personal, work or study.");
    return false;
  }

  if (isDuplicate(trimmedText)) {
    console.log("Not added: a note with this text already exists.");
    return false;
  }

  // Use an ID above the largest existing ID, even if IDs have gaps.
  let nextId = 1;

  for (const note of notes) {
    if (note.id >= nextId) {
      nextId = note.id + 1;
    }
  }

  notes.push({ id: nextId, text: trimmedText, category });
  return true;
}

// Console examples: normal cases with the starting five notes.
console.log("searchNotes (case-insensitive):", searchNotes("JAVASCRIPT")); // Expected: [{ id: 4, text: "Revise JavaScript arrays", category: "study" }]
console.log("searchNotes (no matches):", searchNotes("holiday")); // Expected: []

console.log("longestNote:", longestNote()); // Expected: { id: 3, text: "Email the project report to Grace", category: "work" }
console.log("countByCategory:", countByCategory()); // Expected: { personal: 2, study: 2, work: 1 } (key order does not affect the counts)
console.log("getSummary:", getSummary()); // Expected: "5 notes: 2 personal, 1 work, 2 study."

console.log("isDuplicate (case and extra spaces):", isDuplicate("  BUY   MILK AND BREAD  ")); // Expected: true
console.log("isDuplicate (new text):", isDuplicate("Plan the weekend")); // Expected: false

// Temporarily use an empty array to check the empty-state results.
const startingNotes = notes;
notes = [];

console.log("longestNote (empty):", longestNote()); // Expected: null
console.log("countByCategory (empty):", countByCategory()); // Expected: {}
console.log("getSummary (empty):", getSummary()); // Expected: "0 notes."

// Check singular wording, then restore the starting notes.
notes = [startingNotes[0]];
console.log("getSummary (one note):", getSummary()); // Expected: "1 note: 1 personal."
notes = startingNotes;

// Addition examples: one valid note, followed by rejected notes.
console.log("addNote (valid):", addNote("Plan the weekend", "personal")); // Expected: true; adds { id: 6, text: "Plan the weekend", category: "personal" }
console.log("addNote (duplicate):", addNote("  PLAN   THE WEEKEND  ", "personal")); // Expected: false; logs "Not added: a note with this text already exists."
console.log("addNote (blank):", addNote("   ", "study")); // Expected: false; logs "Not added: note text must be 1–200 characters."
console.log("addNote (too long):", addNote("a".repeat(201), "work")); // Expected: false; logs "Not added: note text must be 1–200 characters."
console.log("addNote (invalid category):", addNote("Book a dentist appointment", "health")); // Expected: false; logs "Not added: category must be personal, work or study."
console.log("addNote (invalid text type):", addNote(null, "personal")); // Expected: false; logs "Not added: note text must be a string."
