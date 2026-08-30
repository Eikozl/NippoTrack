CREATE TABLE content_entry_sessions (
  id_content_entry INT NOT NULL,
  id_session INT NOT NULL,
  PRIMARY KEY (id_content_entry, id_session),
  KEY idx_content_entry_sessions_session (id_session),
  CONSTRAINT fk_content_entry_sessions_content FOREIGN KEY (id_content_entry)
    REFERENCES content_entries (id_content_entry) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_content_entry_sessions_session FOREIGN KEY (id_session)
    REFERENCES study_sessions (id_session) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
