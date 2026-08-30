CREATE TABLE usage_examples (
  id_usage_example INT NOT NULL AUTO_INCREMENT,
  id_vocabulary INT NOT NULL,
  sentence TEXT NOT NULL,
  translation TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id_usage_example),
  KEY idx_usage_examples_vocabulary (id_vocabulary, id_usage_example),
  CONSTRAINT fk_usage_examples_vocabulary FOREIGN KEY (id_vocabulary)
    REFERENCES vocabulary (id_vocabulary) ON DELETE CASCADE ON UPDATE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
