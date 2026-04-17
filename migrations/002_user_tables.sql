-- Migration 002: User and Learner State Tables
-- Users, concept progress, mistake history, conversations, training data, artifacts

-- ============================================================
-- Users
-- ============================================================

CREATE TABLE users (
  user_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  google_oauth_token TEXT,
  google_refresh_token TEXT,
  display_name TEXT,
  background TEXT,
  learning_goals TEXT,
  preferred_style TEXT DEFAULT 'visual-first',
  skill_level TEXT DEFAULT 'beginner',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  failed_login_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMPTZ,
  has_completed_onboarding BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_users_email ON users(email);

-- ============================================================
-- User Concept Progress (Layer 2: Concept Mastery)
-- ============================================================

CREATE TABLE user_concept_progress (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  concept_id UUID NOT NULL REFERENCES concepts(concept_id) ON DELETE CASCADE,
  mastery_percentage INTEGER DEFAULT 0 CHECK (mastery_percentage BETWEEN 0 AND 100),
  status TEXT DEFAULT 'untouched' CHECK (status IN ('untouched', 'learning', 'reviewing', 'mastered')),
  last_struggled_subtopic TEXT,
  confidence_score NUMERIC DEFAULT 0,
  last_interaction_at TIMESTAMPTZ,
  interaction_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, concept_id)
);

CREATE INDEX idx_user_concept_progress_user ON user_concept_progress(user_id);
CREATE INDEX idx_user_concept_progress_status ON user_concept_progress(user_id, status);

-- ============================================================
-- User Mistake History (Layer 3: Mistake History)
-- ============================================================

CREATE TABLE user_mistake_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  concept_id UUID REFERENCES concepts(concept_id) ON DELETE SET NULL,
  misconception_pattern TEXT NOT NULL,
  frequency INTEGER DEFAULT 1,
  resolved BOOLEAN DEFAULT FALSE,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_mistakes_user ON user_mistake_history(user_id);
CREATE INDEX idx_user_mistakes_user_concept ON user_mistake_history(user_id, concept_id);
CREATE INDEX idx_user_mistakes_unresolved ON user_mistake_history(user_id, resolved) WHERE resolved = FALSE;

-- ============================================================
-- Conversations (session history)
-- ============================================================

CREATE TABLE conversations (
  conversation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  topic TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  session_summary TEXT,
  concepts_covered UUID[],
  messages JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_conversations_user_started ON conversations(user_id, started_at DESC);

-- ============================================================
-- Training Data (raw input/output pairs for future fine-tuning)
-- Path 2 of the dual storage architecture (PRD §7.1)
-- ============================================================

CREATE TABLE training_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES conversations(conversation_id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(user_id) ON DELETE SET NULL,
  concept_name TEXT,
  student_mastery_at_time INTEGER,
  identified_mistake TEXT,
  student_input_text TEXT,
  tutor_output_text TEXT,
  analogy_used TEXT,
  correction_applied TEXT,
  exercise_generated TEXT,
  explanation_level TEXT CHECK (explanation_level IN ('fourteen', 'grad_student')),
  tools_triggered TEXT[],
  playbook_executed TEXT,
  mastery_before INTEGER,
  mastery_after INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_training_data_session ON training_data(session_id);
CREATE INDEX idx_training_data_user ON training_data(user_id);
CREATE INDEX idx_training_data_concept ON training_data(concept_name);
CREATE INDEX idx_training_data_level ON training_data(explanation_level);

-- ============================================================
-- Session Artifacts (podcast, video, calendar events)
-- ============================================================

CREATE TABLE session_artifacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('podcast', 'video', 'calendar_event')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  file_url TEXT,
  youtube_video_id TEXT,
  calendar_event_id TEXT,
  duration_seconds INTEGER,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_session_artifacts_session ON session_artifacts(session_id);
CREATE INDEX idx_session_artifacts_user ON session_artifacts(user_id);
CREATE INDEX idx_session_artifacts_status ON session_artifacts(session_id, status);

-- ============================================================
-- Login Attempts (brute-force protection: 5 attempts / 15 min)
-- ============================================================

CREATE TABLE login_attempts (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(user_id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ DEFAULT NOW(),
  success BOOLEAN NOT NULL,
  ip_address TEXT
);

CREATE INDEX idx_login_attempts_user ON login_attempts(user_id, attempted_at DESC);

-- ============================================================
-- User Paper Exposure (tracks what papers/sections a user has seen)
-- ============================================================

CREATE TABLE user_paper_exposure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  paper_id UUID NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
  section_id UUID REFERENCES paper_sections(section_id) ON DELETE SET NULL,
  exposure_type TEXT NOT NULL CHECK (exposure_type IN ('cited_in_response', 'user_opened', 'user_read')),
  seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_paper_exposure_user ON user_paper_exposure(user_id);
CREATE INDEX idx_paper_exposure_user_paper ON user_paper_exposure(user_id, paper_id);

-- ============================================================
-- TTS Usage Tracking (ElevenLabs free tier: 10,000 chars/month)
-- ============================================================

CREATE TABLE tts_usage (
  user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  characters_used INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, month)
);
