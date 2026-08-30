CREATE TABLE session_writings (
  id_session_writing INT NOT NULL AUTO_INCREMENT,
  id_session INT NOT NULL,
  title VARCHAR(150) DEFAULT NULL,
  content TEXT NOT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_session_writing),
  UNIQUE KEY uq_session_writings_session (id_session),
  CONSTRAINT fk_session_writings_session FOREIGN KEY (id_session)
    REFERENCES study_sessions (id_session) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
