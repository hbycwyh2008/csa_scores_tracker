require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { query } = require('./db');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-prod';
const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '') || `http://localhost:${PORT}`;
const TEACHER_EMAIL = (process.env.TEACHER_EMAIL || '').toLowerCase();
const TEACHER_USERNAME = process.env.TEACHER_USERNAME || 'teacher';
const TEACHER_PASSWORD = process.env.TEACHER_PASSWORD || 'teacher123';
const GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/api/auth/google/callback`;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname)));

function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function mapTestRow(t) {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject || 'AP CSA',
    score: t.score != null ? Number(t.score) : null,
    bottomLine: t.bottom_line,
    position: t.position,
    mcqWrong: t.mcq_wrong != null ? Number(t.mcq_wrong) : null,
    frqScore: t.frq_score != null ? Number(t.frq_score) : null,
  };
}
function parseSubjects(str) {
  if (!str || !String(str).trim()) return null;
  return String(str).split(',').map((s) => s.trim()).filter(Boolean);
}
function stringifySubjects(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((s) => String(s).trim()).filter(Boolean).join(',');
}
function mapStudentRow(s) {
  const subjects = parseSubjects(s.subjects);
  return {
    id: s.id,
    name: s.name,
    grade: s.grade,
    subject: s.subject || 'AP CSA',
    subjects: subjects || (s.subject ? [s.subject] : ['AP CSA']),
    email: s.email || null,
    registered: !!s.user_id,
  };
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function requireTeacher(req, res, next) {
  if (req.user.role !== 'teacher') {
    return res.status(403).json({ error: 'Teacher access required' });
  }
  next();
}

function issueToken(user) {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      displayName: user.display_name,
      studentId: user.student_id || null,
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        done(null, profile);
      }
    )
  );
}

async function bootstrapTeacher() {
  if (!TEACHER_EMAIL && !TEACHER_USERNAME) return;
  const hash = bcrypt.hashSync(TEACHER_PASSWORD, 10);
  const { rows } = await query(
    `SELECT id FROM users WHERE role = 'teacher' LIMIT 1`
  );
  if (rows.length === 0) {
    await query(
      `INSERT INTO users (email, username, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4, 'teacher')
       ON CONFLICT (username) DO UPDATE SET password_hash = $3, email = $1`,
      [TEACHER_EMAIL || null, TEACHER_USERNAME, hash, 'Teacher']
    );
    console.log('Teacher account ready:', TEACHER_USERNAME);
  }
}

app.get('/api/auth/google', (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.redirect(BASE_URL + '/?error=google_not_configured');
  }
  const state = req.query.state || 'login';
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    state,
  })(req, res, next);
});

app.get(
  '/api/auth/google/callback',
  (req, res, next) => {
    passport.authenticate('google', (err, profile) => {
      if (err) return res.redirect(`${BASE_URL}/?error=oauth_error`);
      if (!profile) return res.redirect(`${BASE_URL}/?error=no-account`);
      req._googleProfile = profile;
      req._oauthState = req.query.state || 'login';
      next();
    })(req, res, next);
  },
  async (req, res) => {
    const profile = req._googleProfile;
    const state = req._oauthState || 'login';
    const email = (profile.emails && profile.emails[0] && profile.emails[0].value || '').toLowerCase();
    const googleId = profile.id;
    const displayName = profile.displayName || profile.name?.givenName || email || 'User';

    const redirectError = (reason) => {
      const url = new URL(BASE_URL + '/');
      url.searchParams.set('error', reason);
      res.redirect(url.toString());
    };

    const redirectSuccess = (user) => {
      const token = issueToken(user);
      const url = new URL(BASE_URL + '/');
      url.searchParams.set('auth_token', token);
      res.redirect(url.toString());
    };

    try {
      if (state.startsWith('invite::')) {
        const token = state.replace(/^invite::/, '');
        const inv = await query(
          `SELECT it.id, it.student_id, s.name
           FROM invite_tokens it
           JOIN students s ON s.id = it.student_id
           WHERE it.token = $1 AND it.used_at IS NULL AND it.expires_at > NOW()`,
          [token]
        );
        if (inv.rows.length === 0) {
          return redirectError('invite_expired');
        }
        const { student_id } = inv.rows[0];
        const existing = await query(
          `SELECT u.id, u.display_name, u.role FROM users u
           JOIN students s ON s.user_id = u.id WHERE s.id = $1`,
          [student_id]
        );
        if (existing.rows.length > 0) {
          const user = { id: existing.rows[0].id, role: existing.rows[0].role, display_name: existing.rows[0].display_name, student_id };
          await query(`UPDATE users SET google_id = $1, email = $2 WHERE id = $3`, [googleId, email, user.id]);
          await query(`UPDATE invite_tokens SET used_at = NOW() WHERE token = $1`, [token]);
          return redirectSuccess({ ...user, student_id });
        }
        const ins = await query(
          `INSERT INTO users (email, google_id, display_name, role)
           VALUES ($1, $2, $3, 'student')
           RETURNING id`,
          [email, googleId, displayName]
        );
        const userId = ins.rows[0].id;
        await query(`UPDATE students SET user_id = $1 WHERE id = $2`, [userId, student_id]);
        await query(`UPDATE invite_tokens SET used_at = NOW() WHERE token = $1`, [token]);
        const studentRow = await query(`SELECT id FROM students WHERE id = $1`, [student_id]);
        return redirectSuccess({ id: userId, role: 'student', display_name: displayName, student_id: studentRow.rows[0].id });
      }

      let byGoogle = await query(`SELECT id, display_name, role FROM users WHERE google_id = $1`, [googleId]);
      if (byGoogle.rows.length > 0) {
        const u = byGoogle.rows[0];
        const studentRow = await query(`SELECT id FROM students WHERE user_id = $1`, [u.id]);
        return redirectSuccess({ id: u.id, role: u.role, display_name: u.display_name, student_id: studentRow.rows[0]?.id || null });
      }

      let byEmail = await query(`SELECT id, display_name, role FROM users WHERE LOWER(email) = $1`, [email]);
      if (byEmail.rows.length > 0) {
        await query(`UPDATE users SET google_id = $1 WHERE id = $2`, [googleId, byEmail.rows[0].id]);
        const u = byEmail.rows[0];
        const studentRow = await query(`SELECT id FROM students WHERE user_id = $1`, [u.id]);
        return redirectSuccess({ id: u.id, role: u.role, display_name: u.display_name, student_id: studentRow.rows[0]?.id || null });
      }

      if (TEACHER_EMAIL && email === TEACHER_EMAIL) {
        const ins = await query(
          `INSERT INTO users (email, google_id, display_name, role)
           VALUES ($1, $2, $3, 'teacher')
           ON CONFLICT (email) DO UPDATE SET google_id = $2 RETURNING id, display_name, role`,
          [email, googleId, displayName]
        );
        const u = ins.rows[0];
        return redirectSuccess({ id: u.id, role: 'teacher', display_name: u.display_name, student_id: null });
      }

      redirectError('no-account');
    } catch (e) {
      console.error(e);
      redirectError('server_error');
    }
  }
);

app.post('/api/auth/register', async (req, res) => {
  const { email, password, displayName } = req.body || {};
  const emailTrim = (email || '').trim().toLowerCase();
  if (!emailTrim || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const { rows: existing } = await query(`SELECT id FROM users WHERE email = $1 OR username = $1`, [emailTrim, emailTrim]);
  if (existing.length > 0) {
    return res.status(400).json({ error: 'Email already registered' });
  }
  const hash = bcrypt.hashSync(password, 10);
  await query(
    `INSERT INTO users (email, username, password_hash, display_name, role) VALUES ($1, $2, $3, $4, 'pending')`,
    [emailTrim, emailTrim, hash, (displayName || emailTrim).trim() || emailTrim]
  );
  res.status(201).json({ message: 'Registration submitted. Wait for teacher approval and account linking.' });
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username or email and password required' });
  }
  const key = username.trim().toLowerCase();
  const { rows } = await query(
    `SELECT id, password_hash, display_name, role FROM users WHERE username = $1 OR (email IS NOT NULL AND email = $1)`,
    [key]
  );
  if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
    return res.status(401).json({ error: 'Invalid username/email or password' });
  }
  const u = rows[0];
  if (u.role === 'pending') {
    return res.status(401).json({ error: 'Registration pending approval. Please wait for the teacher to approve and link your account to a student.' });
  }
  const studentRow = await query(`SELECT id FROM students WHERE user_id = $1`, [u.id]);
  const token = issueToken({
    id: u.id,
    role: u.role,
    display_name: u.display_name,
    student_id: studentRow.rows[0]?.id || null,
  });
  res.json({ token, role: u.role, displayName: u.display_name, studentId: studentRow.rows[0]?.id || null, id: u.id });
});

app.get('/api/auth/verify', requireAuth, (req, res) => {
  res.json(req.user);
});

app.get('/api/invite/:token', async (req, res) => {
  const { rows } = await query(
    `SELECT s.name, it.used_at, it.expires_at
     FROM invite_tokens it JOIN students s ON s.id = it.student_id
     WHERE it.token = $1`,
    [req.params.token]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Invalid invite link' });
  const r = rows[0];
  res.json({
    studentName: r.name,
    used: !!r.used_at,
    expiresAt: r.expires_at,
    expired: new Date(r.expires_at) < new Date(),
  });
});

app.get('/api/students', requireAuth, requireTeacher, async (req, res) => {
  const { rows } = await query(
    `SELECT s.id, s.name, s.grade, s.subject, s.subjects, s.user_id, u.email
     FROM students s
     LEFT JOIN users u ON u.id = s.user_id
     ORDER BY s.name`
  );
  const students = await Promise.all(
    rows.map(async (s) => {
      const tests = await query(
        `SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position, created_at`,
        [s.id]
      );
      return {
        ...mapStudentRow(s),
        tests: tests.rows.map(mapTestRow),
      };
    })
  );
  res.json(students);
});

app.post('/api/students', requireAuth, requireTeacher, async (req, res) => {
  const { name, grade, subject, subjects } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const subjList = Array.isArray(subjects) && subjects.length > 0 ? subjects : (subject ? [subject] : ['AP CSA']);
  const primarySubject = subjList[0] || 'AP CSA';
  const subjectsStr = stringifySubjects(subjList);
  const { rows } = await query(
    `INSERT INTO students (name, grade, subject, subjects) VALUES ($1, $2, $3, $4) RETURNING id, name, grade, subject, subjects`,
    [name.trim(), grade || '12', primarySubject, subjectsStr]
  );
  const s = rows[0];
  res.status(201).json({ id: s.id, name: s.name, grade: s.grade, subject: s.subject, subjects: parseSubjects(s.subjects) || [s.subject], tests: [] });
});

app.put('/api/students/:id', requireAuth, requireTeacher, async (req, res) => {
  const { name, grade, subject, subjects } = req.body || {};
  const updates = [];
  const params = [];
  let n = 1;
  if (name !== undefined) {
    updates.push(`name = $${n++}`);
    params.push(name.trim());
  }
  if (grade !== undefined) {
    updates.push(`grade = $${n++}`);
    params.push(grade);
  }
  if (subject !== undefined) {
    updates.push(`subject = $${n++}`);
    params.push(subject);
  }
  if (subjects !== undefined) {
    updates.push(`subjects = $${n++}`);
    params.push(stringifySubjects(Array.isArray(subjects) ? subjects : [subjects]));
  }
  if (updates.length === 0) {
    const { rows } = await query(`SELECT id, name, grade, subject, subjects FROM students WHERE id = $1`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
    const s = rows[0];
    const tests = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position`, [s.id]);
    return res.json({ ...mapStudentRow(s), tests: tests.rows.map(mapTestRow) });
  }
  params.push(req.params.id);
  await query(`UPDATE students SET ${updates.join(', ')} WHERE id = $${n}`, params);
  const { rows } = await query(`SELECT id, name, grade, subject, subjects FROM students WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
  const tests = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position`, [req.params.id]);
  res.json({
    ...mapStudentRow(rows[0]),
    tests: tests.rows.map(mapTestRow),
  });
});

app.delete('/api/students/:id', requireAuth, requireTeacher, async (req, res) => {
  const r = await query(`DELETE FROM students WHERE id = $1 RETURNING id`, [req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Student not found' });
  res.json({ success: true });
});

app.post('/api/students/:id/invite', requireAuth, requireTeacher, async (req, res) => {
  const studentId = req.params.id;
  const { rows: student } = await query(`SELECT id FROM students WHERE id = $1`, [studentId]);
  if (student.length === 0) return res.status(404).json({ error: 'Student not found' });
  const token = genToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await query(`DELETE FROM invite_tokens WHERE student_id = $1`, [studentId]);
  await query(
    `INSERT INTO invite_tokens (token, student_id, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
    [token, studentId, req.user.id, expiresAt]
  );
  const url = `${BASE_URL}/invite/${token}`;
  res.json({ url, token, expiresAt });
});

app.post('/api/students/:id/tests', requireAuth, requireTeacher, async (req, res) => {
  const { name, subject, bottomLine, mcqWrong, frqScore } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Test name required' });
  const subj = (subject && (subject === 'AP CSA' || subject === 'AP CSP')) ? subject : 'AP CSA';
  const bl = bottomLine ?? (subj === 'AP CSP' ? 90 : 84);
  const mcq = mcqWrong === undefined || mcqWrong === null || mcqWrong === '' ? null : parseFloat(mcqWrong);
  const frq = frqScore === undefined || frqScore === null || frqScore === '' ? null : parseFloat(frqScore);
  const maxPos = await query(`SELECT COALESCE(MAX(position), 0) + 1 AS pos FROM tests WHERE student_id = $1`, [req.params.id]);
  const pos = maxPos.rows[0].pos;
  const { rows } = await query(
    `INSERT INTO tests (student_id, name, subject, bottom_line, position, mcq_wrong, frq_score) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, subject, score, bottom_line, position, mcq_wrong, frq_score`,
    [req.params.id, name.trim(), subj, bl, pos, mcq, frq]
  );
  res.status(201).json(mapTestRow(rows[0]));
});

app.put('/api/students/:id/tests/:testId', requireAuth, requireTeacher, async (req, res) => {
  const { name, subject, score, bottomLine, mcqWrong, frqScore } = req.body || {};
  const updates = [];
  const params = [];
  let n = 1;
  if (name !== undefined) {
    updates.push(`name = $${n++}`);
    params.push(name.trim());
  }
  if (subject !== undefined && (subject === 'AP CSA' || subject === 'AP CSP')) {
    updates.push(`subject = $${n++}`);
    params.push(subject);
  }
  if (score !== undefined) {
    updates.push(`score = $${n++}`);
    params.push(score === null ? null : parseFloat(score));
  }
  if (bottomLine !== undefined) {
    updates.push(`bottom_line = $${n++}`);
    params.push(bottomLine);
  }
  if (mcqWrong !== undefined) {
    updates.push(`mcq_wrong = $${n++}`);
    params.push(mcqWrong === null || mcqWrong === '' ? null : parseFloat(mcqWrong));
  }
  if (frqScore !== undefined) {
    updates.push(`frq_score = $${n++}`);
    params.push(frqScore === null || frqScore === '' ? null : parseFloat(frqScore));
  }
  if (updates.length === 0) {
    const { rows } = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE id = $1 AND student_id = $2`, [req.params.testId, req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Test not found' });
    return res.json(mapTestRow(rows[0]));
  }
  params.push(req.params.testId, req.params.id);
  await query(`UPDATE tests SET ${updates.join(', ')} WHERE id = $${n} AND student_id = $${n + 1}`, params);
  const { rows } = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE id = $1 AND student_id = $2`, [req.params.testId, req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Test not found' });
  res.json(mapTestRow(rows[0]));
});

app.delete('/api/students/:id/tests/:testId', requireAuth, requireTeacher, async (req, res) => {
  const count = await query(`SELECT COUNT(*) AS c FROM tests WHERE student_id = $1`, [req.params.id]);
  if (Number(count.rows[0].c) <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last test' });
  }
  const r = await query(`DELETE FROM tests WHERE id = $1 AND student_id = $2 RETURNING id`, [req.params.testId, req.params.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Test not found' });
  res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  if (req.user.role === 'teacher') return res.status(400).json({ error: 'Use teacher dashboard' });
  const { rows } = await query(
    `SELECT s.id, s.name, s.grade, s.subject, s.subjects FROM students s WHERE s.user_id = $1`,
    [req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Student not found' });
  const s = rows[0];
  const tests = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position, created_at`, [s.id]);
  res.json({
    id: s.id,
    name: s.name,
    grade: s.grade,
    subject: s.subject,
    subjects: parseSubjects(s.subjects) || (s.subject ? [s.subject] : ['AP CSA']),
    tests: tests.rows.map(mapTestRow),
  });
});

app.get('/api/users', requireAuth, requireTeacher, async (req, res) => {
  const { rows } = await query(
    `SELECT id, email, display_name, role, created_at FROM users`
  );
  const withStudent = await Promise.all(
    rows.map(async (u) => {
      if (u.role !== 'student') return { ...u, student_id: null };
      const s = await query(`SELECT id FROM students WHERE user_id = $1`, [u.id]);
      return { ...u, student_id: s.rows[0]?.id || null };
    })
  );
  res.json(withStudent.map(({ id, email, display_name, role, student_id, created_at }) => ({
    id,
    email,
    displayName: display_name,
    role,
    studentId: student_id,
    createdAt: created_at ? created_at.toISOString() : null,
  })));
});

app.post('/api/users/:id/approve', requireAuth, requireTeacher, async (req, res) => {
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  const { rows: u } = await query(`SELECT id, role FROM users WHERE id = $1`, [req.params.id]);
  if (u.length === 0) return res.status(404).json({ error: 'User not found' });
  if (u[0].role !== 'pending') return res.status(400).json({ error: 'User is not pending approval' });
  const { rows: s } = await query(`SELECT id FROM students WHERE id = $1`, [studentId]);
  if (s.length === 0) return res.status(404).json({ error: 'Student not found' });
  await query(`UPDATE students SET user_id = NULL WHERE user_id = $1`, [u[0].id]);
  await query(`UPDATE students SET user_id = $1 WHERE id = $2`, [u[0].id, studentId]);
  await query(`UPDATE users SET role = 'student' WHERE id = $1`, [u[0].id]);
  res.json({ success: true, studentId });
});

app.post('/api/users/:id/reject', requireAuth, requireTeacher, async (req, res) => {
  const { rows } = await query(`SELECT id, role FROM users WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
  if (rows[0].role !== 'pending') return res.status(400).json({ error: 'User is not pending' });
  await query(`DELETE FROM users WHERE id = $1`, [req.params.id]);
  res.json({ success: true });
});

app.get('/api/viewer-links', requireAuth, requireTeacher, async (req, res) => {
  const { rows } = await query(
    `SELECT id, token, name, allow_view_scores, created_at FROM viewer_links WHERE created_by = $1 ORDER BY created_at DESC`,
    [req.user.id]
  );
  const withStudents = await Promise.all(
    rows.map(async (v) => {
      const st = await query(`SELECT student_id FROM viewer_link_students WHERE viewer_link_id = $1`, [v.id]);
      return { id: v.id, token: v.token, name: v.name, allowViewScores: v.allow_view_scores !== false, studentIds: st.rows.map((r) => r.student_id), createdAt: v.created_at };
    })
  );
  res.json(withStudents);
});

app.post('/api/viewer-links', requireAuth, requireTeacher, async (req, res) => {
  const { name, studentIds, allowViewScores } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const token = genToken();
  const allowScores = allowViewScores !== false;
  const { rows } = await query(
    `INSERT INTO viewer_links (token, name, allow_view_scores, created_by) VALUES ($1, $2, $3, $4) RETURNING id, token, name, allow_view_scores`,
    [token, name.trim(), allowScores, req.user.id]
  );
  const v = rows[0];
  const ids = Array.isArray(studentIds) ? studentIds : [];
  for (const sid of ids) {
    await query(`INSERT INTO viewer_link_students (viewer_link_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [v.id, sid]);
  }
  res.status(201).json({ id: v.id, token: v.token, name: v.name, allowViewScores: v.allow_view_scores !== false, url: `${BASE_URL}/view/link/${v.token}` });
});

app.put('/api/viewer-links/:id', requireAuth, requireTeacher, async (req, res) => {
  const { name, studentIds, allowViewScores } = req.body || {};
  const { rows } = await query(`SELECT id FROM viewer_links WHERE id = $1 AND created_by = $2`, [req.params.id, req.user.id]);
  if (rows.length === 0) return res.status(404).json({ error: 'Viewer link not found' });
  if (name !== undefined && name.trim()) {
    await query(`UPDATE viewer_links SET name = $1 WHERE id = $2`, [name.trim(), req.params.id]);
  }
  if (allowViewScores !== undefined) {
    await query(`UPDATE viewer_links SET allow_view_scores = $1 WHERE id = $2`, [allowViewScores === true, req.params.id]);
  }
  if (Array.isArray(studentIds)) {
    await query(`DELETE FROM viewer_link_students WHERE viewer_link_id = $1`, [req.params.id]);
    for (const sid of studentIds) {
      await query(`INSERT INTO viewer_link_students (viewer_link_id, student_id) VALUES ($1, $2)`, [req.params.id, sid]);
    }
  }
  const v = await query(`SELECT id, token, name, allow_view_scores FROM viewer_links WHERE id = $1`, [req.params.id]);
  const st = await query(`SELECT student_id FROM viewer_link_students WHERE viewer_link_id = $1`, [req.params.id]);
  res.json({ ...v.rows[0], allowViewScores: v.rows[0].allow_view_scores !== false, studentIds: st.rows.map((r) => r.student_id), url: `${BASE_URL}/view/link/${v.rows[0].token}` });
});

app.delete('/api/viewer-links/:id', requireAuth, requireTeacher, async (req, res) => {
  const r = await query(`DELETE FROM viewer_links WHERE id = $1 AND created_by = $2 RETURNING id`, [req.params.id, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Viewer link not found' });
  res.json({ success: true });
});

app.get('/api/view/link/:token', async (req, res) => {
  const { rows: link } = await query(
    `SELECT id, name, allow_view_scores FROM viewer_links WHERE token = $1`,
    [req.params.token]
  );
  if (link.length === 0) return res.status(404).json({ error: 'Invalid or expired link' });
  const allowViewScores = link[0].allow_view_scores !== false;
  const studentIds = await query(`SELECT student_id FROM viewer_link_students WHERE viewer_link_id = $1`, [link[0].id]);
  if (studentIds.rows.length === 0) {
    return res.json({ name: link[0].name, allowViewScores: true, students: [] });
  }
  const students = [];
  for (const { student_id } of studentIds.rows) {
    const s = await query(`SELECT id, name, grade, subject, subjects FROM students WHERE id = $1`, [student_id]);
    if (s.rows.length === 0) continue;
    const r = s.rows[0];
    const t = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position`, [student_id]);
    students.push({
      id: r.id,
      name: r.name,
      grade: r.grade,
      subject: r.subject,
      subjects: parseSubjects(r.subjects) || (r.subject ? [r.subject] : ['AP CSA']),
      tests: t.rows.map((x) => {
        const m = mapTestRow(x);
        if (!allowViewScores) m.score = null;
        return m;
      }),
    });
  }
  res.json({ name: link[0].name, allowViewScores, students });
});

app.post('/api/students/:id/share', requireAuth, requireTeacher, async (req, res) => {
  const studentId = req.params.id;
  const { expiresInDays } = req.body || {};
  const { rows: student } = await query(`SELECT id FROM students WHERE id = $1`, [studentId]);
  if (student.length === 0) return res.status(404).json({ error: 'Student not found' });
  let existing = await query(`SELECT token, expires_at FROM share_links WHERE student_id = $1 AND created_by = $2 ORDER BY created_at DESC LIMIT 1`, [studentId, req.user.id]);
  if (existing.rows.length > 0) {
    const e = existing.rows[0];
    const expired = e.expires_at && new Date(e.expires_at) < new Date();
    if (!expired) {
      return res.json({ url: `${BASE_URL}/view/student/${e.token}`, token: e.token });
    }
  }
  const token = genToken();
  const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null;
  await query(
    `INSERT INTO share_links (token, student_id, created_by, expires_at) VALUES ($1, $2, $3, $4)`,
    [token, studentId, req.user.id, expiresAt]
  );
  res.status(201).json({ url: `${BASE_URL}/view/student/${token}`, token, expiresAt });
});

app.post('/api/students/:id/share/regenerate', requireAuth, requireTeacher, async (req, res) => {
  const studentId = req.params.id;
  await query(`DELETE FROM share_links WHERE student_id = $1 AND created_by = $2`, [studentId, req.user.id]);
  const token = genToken();
  await query(
    `INSERT INTO share_links (token, student_id, created_by) VALUES ($1, $2, $3)`,
    [token, studentId, req.user.id]
  );
  res.json({ url: `${BASE_URL}/view/student/${token}`, token });
});

app.get('/api/share/:token', async (req, res) => {
  const { rows } = await query(
    `SELECT sl.token, s.id, s.name, s.grade, s.subject, sl.expires_at
     FROM share_links sl JOIN students s ON s.id = sl.student_id
     WHERE sl.token = $1`,
    [req.params.token]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Invalid link' });
  const r = rows[0];
  if (r.expires_at && new Date(r.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Link expired' });
  }
  const tests = await query(`SELECT id, name, subject, score, bottom_line, position, mcq_wrong, frq_score FROM tests WHERE student_id = $1 ORDER BY position`, [r.id]);
  res.json({
    id: r.id,
    name: r.name,
    grade: r.grade,
    subject: r.subject,
    tests: tests.rows.map(mapTestRow),
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'index.html'));
});

async function start() {
  try {
    await query('SELECT 1');
  } catch (e) {
    console.error('Database connection failed. Set DATABASE_URL and run npm run db:init');
    process.exit(1);
  }
  await bootstrapTeacher();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Listening on 0.0.0.0:${PORT}`);
    console.log(`AP Score Tracker → ${BASE_URL}`);
  });
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
