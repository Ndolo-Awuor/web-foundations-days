// 1. Select the page elements and keep the fetched users in memory.
const loadButton = document.querySelector("#load-users");
const filterInput = document.querySelector("#filter-input");
const status = document.querySelector("#status");
const usersList = document.querySelector("#users-list");

const USERS_URL = "https://jsonplaceholder.typicode.com/users";
let users = [];
let hasLoaded = false;
let isLoading = false;

// 2. Draw any array of users. textContent keeps all API text as plain text.
function renderUsers(list) {
  usersList.replaceChildren();

  if (list.length === 0) {
    const message = document.createElement("li");
    message.classList.add("empty-message");
    message.textContent = "No users match your filter.";
    usersList.appendChild(message);
    return;
  }

  list.forEach((user) => {
    const card = document.createElement("li");
    card.classList.add("user-card");

    const name = document.createElement("h3");
    name.textContent = user.name;

    const email = document.createElement("p");
    email.textContent = `Email: ${user.email}`;

    const city = document.createElement("p");
    city.textContent = `City: ${user.address.city}`;

    const company = document.createElement("p");
    company.textContent = `Company: ${user.company.name}`;

    card.append(name, email, city, company);
    usersList.appendChild(card);
  });
}

// 3. Filter the stored users without making another network request.
function applyFilter() {
  if (!hasLoaded || isLoading) return;

  const search = filterInput.value.trim().toLowerCase();
  const filteredUsers = users.filter((user) =>
    user.name.toLowerCase().includes(search),
  );

  renderUsers(filteredUsers);
  const noun = users.length === 1 ? "user" : "users";
  status.textContent = `Loaded ${users.length} ${noun}. Showing ${filteredUsers.length} of ${users.length}.`;
  status.className = "success";
}

// 4. Fetch users and always re-enable the button, including after errors.
async function loadUsers() {
  if (isLoading) return;

  isLoading = true;
  hasLoaded = false;
  users = [];
  usersList.replaceChildren();
  loadButton.disabled = true;
  loadButton.textContent = "Loading…";
  usersList.setAttribute("aria-busy", "true");
  status.className = "";
  status.textContent = "Loading users…";

  try {
    const response = await fetch(USERS_URL);

    // fetch can resolve even when the server returns an HTTP error.
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) {
      throw new Error("The server did not return a user list.");
    }

    users = data;
    hasLoaded = true;
  } catch (error) {
    users = [];
    hasLoaded = false;
    usersList.replaceChildren();
    status.className = "error";
    status.textContent = `Could not load users. ${error.message} Please try again.`;
  } finally {
    isLoading = false;
    loadButton.disabled = false;
    loadButton.textContent = "Load users";
    usersList.setAttribute("aria-busy", "false");
  }

  // Respect a filter typed before or during loading.
  if (hasLoaded) applyFilter();
}

// 5. Load on button click and update the display on each input event.
loadButton.addEventListener("click", loadUsers);
filterInput.addEventListener("input", applyFilter);
