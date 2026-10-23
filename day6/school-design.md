# Day 6: A School Database

## Tables

- **students** stores each student's `id`, `name` and `email`. The primary key
  `id` identifies a student. Name and email are required. Email is unique and
  uses `COLLATE NOCASE`, so changing a sample email's letter case does not allow
  a duplicate. Names are not unique because different students can share a name.
- **courses** stores each course's primary key `id` and required `name`.
- **enrolments** records a student's participation in a course. It has a primary
  key `id`, required foreign keys `student_id` and `course_id`, and a numeric
  `grade` between 0 and 100. A grade can be `NULL` until it is awarded.

The foreign keys prevent enrolments from referring to students or courses that
do not exist. `PRAGMA foreign_keys = ON` enables this enforcement in SQLite.
`UNIQUE (student_id, course_id)` prevents a student enrolling in the same course
twice. There is no automatic cascading deletion of enrolments.

## Relationships

- **students to enrolments is one-to-many:** one student can have many enrolment
  rows, but each enrolment belongs to exactly one student.
- **courses to enrolments is one-to-many:** one course can have many enrolment
  rows, but each enrolment belongs to exactly one course.
- **students to courses is many-to-many:** a student can study several courses,
  and a course can contain several students. The `enrolments` join table stores
  each student/course pair. The grade belongs here because it describes that
  student's result in that particular course. Comma-separated course IDs in a
  student record would make joins, validation and grade storage harder.

Students and courses can exist without any enrolments.

## Index

The script adds `idx_enrolments_course_id` on `enrolments(course_id)`. It helps
the database find enrolments when listing students on a course or counting
students per course. The unique student/course constraint already creates an
index beginning with `student_id`; a separate course-first index serves the
opposite lookup direction. Indexes use storage and add work to writes, so each
should support a useful query.

## SQL or NoSQL?

I would choose SQL for this system because students, courses and enrolments have
a clear structure and relationships. Foreign keys keep references valid, unique
constraints prevent duplicate emails and enrolments, and joins and aggregation
answer the required questions directly. SQL transactions can keep related changes
consistent. A NoSQL database could store school data, but this small relational
system benefits from SQLite's built-in constraints and queries without needing
extra application code to enforce the same relationships.

## Running the assignment

Select SQLite in a playground such as [SQLite Online](https://sqliteonline.com/),
start with a new, empty database, and run `school.sql` from top to bottom. If
using an editor that runs only selected text, select the whole script. Creating
the same tables again in the same database will report that they already exist.

The data contains four students, three courses and five enrolments. Comments
beside each required query give the expected results. Zipporah Kwamboka has no
enrolments, so the fourth query has a visible result. The final statement verifies
that Judith Kerubo's Database Fundamentals grade changed from `NULL` to `92`.
