CREATE TABLE tag_study_sessions (
  id_tag INT NOT NULL,
  id_session INT NOT NULL,
  PRIMARY KEY (id_tag, id_session),
  KEY idx_tag_study_sessions_session (id_session),
  CONSTRAINT fk_tag_study_sessions_tag FOREIGN KEY (id_tag) REFERENCES tags (id_tag) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_tag_study_sessions_session FOREIGN KEY (id_session) REFERENCES study_sessions (id_session) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE tag_vocabulary (
  id_tag INT NOT NULL,
  id_vocabulary INT NOT NULL,
  PRIMARY KEY (id_tag, id_vocabulary),
  KEY idx_tag_vocabulary_vocabulary (id_vocabulary),
  CONSTRAINT fk_tag_vocabulary_tag FOREIGN KEY (id_tag) REFERENCES tags (id_tag) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_tag_vocabulary_vocabulary FOREIGN KEY (id_vocabulary) REFERENCES vocabulary (id_vocabulary) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE tag_kanji (
  id_tag INT NOT NULL,
  id_kanji INT NOT NULL,
  PRIMARY KEY (id_tag, id_kanji),
  KEY idx_tag_kanji_kanji (id_kanji),
  CONSTRAINT fk_tag_kanji_tag FOREIGN KEY (id_tag) REFERENCES tags (id_tag) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_tag_kanji_kanji FOREIGN KEY (id_kanji) REFERENCES kanji (id_kanji) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE tag_grammar (
  id_tag INT NOT NULL,
  id_grammar INT NOT NULL,
  PRIMARY KEY (id_tag, id_grammar),
  KEY idx_tag_grammar_grammar (id_grammar),
  CONSTRAINT fk_tag_grammar_tag FOREIGN KEY (id_tag) REFERENCES tags (id_tag) ON DELETE CASCADE ON UPDATE RESTRICT,
  CONSTRAINT fk_tag_grammar_grammar FOREIGN KEY (id_grammar) REFERENCES grammar_points (id_grammar) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
