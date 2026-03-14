CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT UNIQUE,
  username     TEXT UNIQUE,
  password_hash TEXT,
  google_id    TEXT UNIQUE,
  display_name TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('teacher', 'student', 'pending')),
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS students (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  grade      TEXT DEFAULT '12',
  subject    TEXT DEFAULT 'AP CSA',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invite_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT UNIQUE NOT NULL,
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id),
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT 'AP CSA',
  score       NUMERIC(5,2),
  bottom_line INTEGER DEFAULT 84,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Viewer links: 行政/申请老师 — token grants access to a set of students; allow_view_scores 控制是否可查看成绩
CREATE TABLE IF NOT EXISTS viewer_links (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token             TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  allow_view_scores  BOOLEAN NOT NULL DEFAULT true,
  created_by        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS viewer_link_students (
  viewer_link_id UUID NOT NULL REFERENCES viewer_links(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  PRIMARY KEY (viewer_link_id, student_id)
);

-- Student share links: 给学生免注册 — one token = one student, read-only
CREATE TABLE IF NOT EXISTS share_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token       TEXT UNIQUE NOT NULL,
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
