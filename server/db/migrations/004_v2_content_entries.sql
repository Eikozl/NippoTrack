CREATE TABLE content_entries (
  id_content_entry INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  content_type VARCHAR(20) NOT NULL,
  content_date DATE NOT NULL,
  perceived_difficulty TINYINT DEFAULT NULL,
  comprehension_percent TINYINT DEFAULT NULL,
  new_words_count INT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_content_entry),
  KEY idx_content_entries_date (content_date),
  KEY idx_content_entries_type_date (content_type, content_date),
  CONSTRAINT chk_content_entries_type CHECK (content_type IN ('Anime', 'Manga', 'Book', 'Article', 'YouTube', 'Podcast', 'Game', 'Conversation')),
  CONSTRAINT chk_content_entries_difficulty CHECK (perceived_difficulty BETWEEN 1 AND 5 OR perceived_difficulty IS NULL),
  CONSTRAINT chk_content_entries_comprehension CHECK (comprehension_percent BETWEEN 0 AND 100 OR comprehension_percent IS NULL),
  CONSTRAINT chk_content_entries_words CHECK (new_words_count >= 0 OR new_words_count IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
