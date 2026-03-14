require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('./index.js');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

function runMigration() {
  return pool.query(`
    ALTER TABLE tests ADD COLUMN IF NOT EXISTS subject TEXT NOT NULL DEFAULT 'AP CSA';
  `).catch(() => {})
  .then(() => pool.query(`
    ALTER TABLE viewer_links ADD COLUMN IF NOT EXISTS allow_view_scores BOOLEAN NOT NULL DEFAULT true;
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('teacher', 'student', 'pending'));
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE tests ADD COLUMN IF NOT EXISTS mcq_wrong INTEGER;
  `).catch(() => {}))
  .then(() => pool.query(`
    ALTER TABLE tests ADD COLUMN IF NOT EXISTS frq_score NUMERIC(5,2);
  `).catch(() => {}));
}

function seedIfEmpty() {
  return pool.query('SELECT COUNT(*) AS c FROM students')
    .then((r) => {
      if (Number(r.rows[0].c) !== 0) return null;
      return pool.query(
        `INSERT INTO students (name, grade, subject) VALUES ('Sample Student A', '12', 'AP CSA'), ('Sample Student B', '11', 'AP CSA') RETURNING id`
      );
    })
    .then((ids) => {
      if (!ids || ids.rows.length < 2) return null;
      const [id1, id2] = [ids.rows[0].id, ids.rows[1].id];
      return pool.query(
        `INSERT INTO tests (student_id, name, subject, score, bottom_line, position) VALUES
         ($1, 'Mock 1', 'AP CSA', 78, 84, 1), ($1, 'Mock 2', 'AP CSA', 82, 84, 2), ($1, 'Practice', 'AP CSP', 85, 90, 3),
         ($2, 'Unit 1', 'AP CSP', 88, 90, 1), ($2, 'Unit 2', 'AP CSP', 85, 90, 2), ($2, 'CSA Quiz', 'AP CSA', 80, 84, 3)`,
        [id1, id2]
      );
    });
}

pool.query(sql)
  .then(() => runMigration())
  .then(() => seedIfEmpty())
  .then(() => {
    console.log('Database initialized.');
    pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
