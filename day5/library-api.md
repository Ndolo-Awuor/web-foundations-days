# Library Books REST API Design

This document proposes a REST API for managing a library's books. It is a design,
not a running API. All paths below are relative to the API's base URL.

## Book resource and request rules

- Each book has a server-generated positive integer `id`, a `title`, an `author`,
  an `isbn`, and a `publishedYear`.
- `title`, `author`, and `isbn` must be non-empty strings after trimming.
- `publishedYear` must be a positive integer.
- Requests containing JSON use `Content-Type: application/json`.
- Responses containing JSON use `Content-Type: application/json`.
- Collection responses are arrays; single-book responses are objects.

Example book response:

```json
{
  "id": 42,
  "title": "Kindred",
  "author": "Octavia Butler",
  "isbn": "9780807083697",
  "publishedYear": 1979
}
```

## 1. List all books

- **Method:** `GET`
- **Path:** `/books`
- **Description:** Return an array of all books in the library.
- **Request body:** None.
- **Success:** `200 OK`, with a JSON array of books (`[]` if the library is empty).

## 2. Get one book

- **Method:** `GET`
- **Path:** `/books/42`
- **Description:** Return the book whose ID is `42`.
- **Request body:** None.
- **Success:** `200 OK`, with the book object.

## 3. Create a book

- **Method:** `POST`
- **Path:** `/books`
- **Description:** Create a book and assign it a new ID.
- **Success:** `201 Created`, with the created book object and a `Location` header
  pointing to its path, such as `/books/42`.
- **Example request body:**

```json
{
  "title": "Kindred",
  "author": "Octavia Butler",
  "isbn": "9780807083697",
  "publishedYear": 1979
}
```

## 4. Update a book

- **Method:** `PUT`
- **Path:** `/books/42`
- **Description:** Replace all editable fields of the existing book, keeping its ID.
- **Success:** `200 OK`, with the updated book object.
- **Example request body:** All four editable fields are required.

```json
{
  "title": "Kindred",
  "author": "Octavia E. Butler",
  "isbn": "9780807083697",
  "publishedYear": 1979
}
```

## 5. Delete a book

- **Method:** `DELETE`
- **Path:** `/books/42`
- **Description:** Delete the existing book whose ID is `42`.
- **Request body:** None.
- **Success:** `204 No Content`, with no response body.

## 6. List books by an author

- **Method:** `GET`
- **Path:** `/books?author=Octavia%20Butler`
- **Description:** Return books whose author matches the query value, ignoring case.
- **Request body:** None.
- **Success:** `200 OK`, with a JSON array of matching books.
- The `author` query parameter is an exact match after trimming and ignoring case;
  spaces in the URL are encoded as `%20`.
- An author with no matching books returns `200 OK` with `[]`, not `404`.

## Error responses

### 400 Bad Request

- The request is invalid and cannot be processed.
- Examples: malformed JSON; a missing or blank title in a `POST` or `PUT` body;
  a negative `publishedYear`; a non-integer ID such as `/books/abc`; or a blank
  author query such as `/books?author=`.
- Example response for a blank title:

```json
{
  "error": "Title is required and must not be blank."
}
```

### 404 Not Found

- The requested book or API route does not exist.
- Examples: `GET /books/999`, `PUT /books/999`, or `DELETE /books/999` when no book
  has ID `999`.
- Example response:

```json
{
  "error": "Book 999 was not found."
}
```
