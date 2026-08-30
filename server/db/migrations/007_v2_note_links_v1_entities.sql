CREATE TABLE note_study_sessions (
  id_note INT NOT NULL,
  id_session INT NOT NULL,
  PRIMARY KEY (id_note, id_session),
  KEY idx_note_study_sessions_session (id_session),
  CONSTRAINT fk_note_study_sessions_note FOREIGN KEY (id_note) REFERENCES notes (id_note) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_note_study_sessions_session FOREIGN KEY (id_session) REFERENCES study_sessions (id_session) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE note_vocabulary (
  id_note INT NOT NULL,
  id_vocabulary INT NOT NULL,
  PRIMARY KEY (id_note, id_vocabulary),
  KEY idx_note_vocabulary_vocabulary (id_vocabulary),
  CONSTRAINT fk_note_vocabulary_note FOREIGN KEY (id_note) REFERENCES notes (id_note) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_note_vocabulary_vocabulary FOREIGN KEY (id_vocabulary) REFERENCES vocabulary (id_vocabulary) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE note_kanji (
  id_note INT NOT NULL,
  id_kanji INT NOT NULL,
  PRIMARY KEY (id_note, id_kanji),
  KEY idx_note_kanji_kanji (id_kanji),
  CONSTRAINT fk_note_kanji_note FOREIGN KEY (id_note) REFERENCES notes (id_note) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_note_kanji_kanji FOREIGN KEY (id_kanji) REFERENCES kanji (id_kanji) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE note_grammar (
  id_note INT NOT NULL,
  id_grammar INT NOT NULL,
  PRIMARY KEY (id_note, id_grammar),
  KEY idx_note_grammar_grammar (id_grammar),
  CONSTRAINT fk_note_grammar_note FOREIGN KEY (id_note) REFERENCES notes (id_note) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_note_grammar_grammar FOREIGN KEY (id_grammar) REFERENCES grammar_points (id_grammar) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
