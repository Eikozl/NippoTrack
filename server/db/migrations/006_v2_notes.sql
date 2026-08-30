CREATE TABLE notes (
  id_note INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(150) DEFAULT NULL,
  body TEXT NOT NULL,
  category VARCHAR(20) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_note),
  KEY idx_notes_category_updated (category, updated_at),
  CONSTRAINT chk_notes_category CHECK (category IN ('Grammar', 'Vocabulary', 'JapaneseQuestion', 'Correction', 'Resource', 'General'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
