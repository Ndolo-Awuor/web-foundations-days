-- Day 6 assignment: A School Database
-- Run this script once in a new, empty SQLite database.

-- SQLite requires foreign-key enforcement to be enabled for each connection.
PRAGMA foreign_keys = ON;

-- 1. Create the tables.
CREATE TABLE students (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE
);

CREATE TABLE courses (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE enrolments (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL,
    course_id INTEGER NOT NULL,
    -- NULL means the student has not received a grade yet.
    grade INTEGER CHECK (grade BETWEEN 0 AND 100),
    FOREIGN KEY (student_id) REFERENCES students(id),
    FOREIGN KEY (course_id) REFERENCES courses(id),
    UNIQUE (student_id, course_id)
);

-- Course lookups benefit from an index starting with course_id.
-- UNIQUE (student_id, course_id) already indexes student-first lookups.
CREATE INDEX idx_enrolments_course_id ON enrolments(course_id);

-- 2. Add four students, three courses and five enrolments.
-- These names are fictional sample records; the email domain is for examples.
INSERT INTO students (id, name, email) VALUES
    (1, 'Judith Kerubo', 'judith.kerubo@example.com'),
    (2, 'Peter Onyango', 'peter.onyango@example.com'),
    (3, 'Mike Ndolo', 'mike.ndolo@example.com'),
    (4, 'Zipporah Kwamboka', 'zipporah.kwamboka@example.com');

INSERT INTO courses (id, name) VALUES
    (1, 'Web Development'),
    (2, 'Database Fundamentals'),
    (3, 'Python Programming');

INSERT INTO enrolments (id, student_id, course_id, grade) VALUES
    (1, 1, 1, 85),
    (2, 1, 2, NULL),
    (3, 2, 1, 78),
    (4, 2, 3, 91),
    (5, 3, 2, 88);

-- 3. Required queries.

-- Query 1: All courses for one student, selected by name.
-- Expected: Judith Kerubo's Web Development (85) and Database Fundamentals (NULL).
SELECT s.name AS student, c.name AS course, e.grade
FROM students AS s
JOIN enrolments AS e ON e.student_id = s.id
JOIN courses AS c ON c.id = e.course_id
WHERE s.name = 'Judith Kerubo'
ORDER BY c.id;

-- Query 2: All students on one course.
-- Expected: Judith Kerubo (85) and Peter Onyango (78) on Web Development.
SELECT c.name AS course, s.name AS student, e.grade
FROM courses AS c
JOIN enrolments AS e ON e.course_id = c.id
JOIN students AS s ON s.id = e.student_id
WHERE c.name = 'Web Development'
ORDER BY s.id;

-- Query 3: Number of students per course, including courses with zero enrolments.
-- Expected: Web Development = 2; Database Fundamentals = 2; Python Programming = 1.
-- COUNT(e.student_id), rather than COUNT(*), gives zero for an empty course.
SELECT c.name AS course, COUNT(e.student_id) AS student_count
FROM courses AS c
LEFT JOIN enrolments AS e ON e.course_id = c.id
GROUP BY c.id, c.name
ORDER BY c.id;

-- Query 4: Students who have no enrolments.
-- Expected: Zipporah Kwamboka, zipporah.kwamboka@example.com.
SELECT s.name AS student, s.email
FROM students AS s
LEFT JOIN enrolments AS e ON e.student_id = s.id
WHERE e.id IS NULL
ORDER BY s.id;

-- Query 5: Update exactly one enrolment's grade.
-- The unique student/course pair identifies Judith's Database Fundamentals enrolment.
UPDATE enrolments
SET grade = 92
WHERE student_id = 1 AND course_id = 2;

-- Verify Query 5. Expected: Judith Kerubo, Database Fundamentals, 92.
SELECT s.name AS student, c.name AS course, e.grade
FROM enrolments AS e
JOIN students AS s ON s.id = e.student_id
JOIN courses AS c ON c.id = e.course_id
WHERE e.student_id = 1 AND e.course_id = 2;
