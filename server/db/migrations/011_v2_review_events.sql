CREATE TABLE review_events (
  id_review_event INT NOT NULL AUTO_INCREMENT,
  id_review_item INT NOT NULL,
  reviewed_at DATETIME NOT NULL,
  result VARCHAR(20) NOT NULL,
  previous_interval_days SMALLINT UNSIGNED NOT NULL,
  next_interval_days SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (id_review_event),
  KEY idx_review_events_item_reviewed (id_review_item, reviewed_at),
  CONSTRAINT fk_review_events_item FOREIGN KEY (id_review_item) REFERENCES review_items (id_review_item) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
