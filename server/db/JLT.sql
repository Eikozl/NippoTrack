-- MySQL dump 10.13  Distrib 8.0.46, for Win64 (x86_64)
--
-- Host: 127.0.0.1    Database: jlt
-- ------------------------------------------------------
-- Server version	5.5.5-10.4.32-MariaDB

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `grammar_points`
--

DROP TABLE IF EXISTS `grammar_points`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `grammar_points` (
  `id_grammar` int(11) NOT NULL AUTO_INCREMENT,
  `grammar_point` varchar(100) NOT NULL,
  `meaning` varchar(255) NOT NULL,
  `structure` text DEFAULT NULL,
  `example` text DEFAULT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_grammar`),
  UNIQUE KEY `grammar_point` (`grammar_point`),
  KEY `idx_grammar_jlpt` (`jlpt_level`),
  KEY `idx_grammar_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `grammar_points`
--

LOCK TABLES `grammar_points` WRITE;
/*!40000 ALTER TABLE `grammar_points` DISABLE KEYS */;
/*!40000 ALTER TABLE `grammar_points` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `kanji`
--

DROP TABLE IF EXISTS `kanji`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `kanji` (
  `id_kanji` int(11) NOT NULL AUTO_INCREMENT,
  `character_kanji` varchar(4) NOT NULL,
  `meaning` varchar(255) NOT NULL,
  `onyomi` varchar(255) DEFAULT NULL,
  `kunyomi` varchar(255) DEFAULT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_kanji`),
  UNIQUE KEY `character_kanji` (`character_kanji`),
  KEY `idx_kanji_jlpt` (`jlpt_level`),
  KEY `idx_kanji_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `kanji`
--

LOCK TABLES `kanji` WRITE;
/*!40000 ALTER TABLE `kanji` DISABLE KEYS */;
/*!40000 ALTER TABLE `kanji` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `kanji_vocabulary`
--

DROP TABLE IF EXISTS `kanji_vocabulary`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `kanji_vocabulary` (
  `id_kanji` int(11) NOT NULL,
  `id_vocabulary` int(11) NOT NULL,
  PRIMARY KEY (`id_kanji`,`id_vocabulary`),
  KEY `id_vocabulary` (`id_vocabulary`),
  CONSTRAINT `kanji_vocabulary_ibfk_1` FOREIGN KEY (`id_kanji`) REFERENCES `kanji` (`id_kanji`) ON DELETE CASCADE,
  CONSTRAINT `kanji_vocabulary_ibfk_2` FOREIGN KEY (`id_vocabulary`) REFERENCES `vocabulary` (`id_vocabulary`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `kanji_vocabulary`
--

LOCK TABLES `kanji_vocabulary` WRITE;
/*!40000 ALTER TABLE `kanji_vocabulary` DISABLE KEYS */;
/*!40000 ALTER TABLE `kanji_vocabulary` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `session_grammar`
--

DROP TABLE IF EXISTS `session_grammar`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `session_grammar` (
  `id_session` int(11) NOT NULL,
  `id_grammar` int(11) NOT NULL,
  PRIMARY KEY (`id_session`,`id_grammar`),
  KEY `id_grammar` (`id_grammar`),
  CONSTRAINT `session_grammar_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  CONSTRAINT `session_grammar_ibfk_2` FOREIGN KEY (`id_grammar`) REFERENCES `grammar_points` (`id_grammar`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `session_grammar`
--

LOCK TABLES `session_grammar` WRITE;
/*!40000 ALTER TABLE `session_grammar` DISABLE KEYS */;
/*!40000 ALTER TABLE `session_grammar` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `session_kanji`
--

DROP TABLE IF EXISTS `session_kanji`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `session_kanji` (
  `id_session` int(11) NOT NULL,
  `id_kanji` int(11) NOT NULL,
  PRIMARY KEY (`id_session`,`id_kanji`),
  KEY `id_kanji` (`id_kanji`),
  CONSTRAINT `session_kanji_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  CONSTRAINT `session_kanji_ibfk_2` FOREIGN KEY (`id_kanji`) REFERENCES `kanji` (`id_kanji`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `session_kanji`
--

LOCK TABLES `session_kanji` WRITE;
/*!40000 ALTER TABLE `session_kanji` DISABLE KEYS */;
/*!40000 ALTER TABLE `session_kanji` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `session_vocabulary`
--

DROP TABLE IF EXISTS `session_vocabulary`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `session_vocabulary` (
  `id_session` int(11) NOT NULL,
  `id_vocabulary` int(11) NOT NULL,
  PRIMARY KEY (`id_session`,`id_vocabulary`),
  KEY `id_vocabulary` (`id_vocabulary`),
  CONSTRAINT `session_vocabulary_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  CONSTRAINT `session_vocabulary_ibfk_2` FOREIGN KEY (`id_vocabulary`) REFERENCES `vocabulary` (`id_vocabulary`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `session_vocabulary`
--

LOCK TABLES `session_vocabulary` WRITE;
/*!40000 ALTER TABLE `session_vocabulary` DISABLE KEYS */;
/*!40000 ALTER TABLE `session_vocabulary` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `study_sessions`
--

DROP TABLE IF EXISTS `study_sessions`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `study_sessions` (
  `id_session` int(11) NOT NULL AUTO_INCREMENT,
  `session_date` date NOT NULL,
  `duration_minutes` int(11) NOT NULL CHECK (`duration_minutes` > 0),
  `category` varchar(20) NOT NULL CHECK (`category` in ('Grammar','Vocabulary','Kanji','Reading','Listening','Speaking','Writing','Mixed')),
  `resource` varchar(255) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_session`),
  KEY `idx_sessions_date` (`session_date`),
  KEY `idx_sessions_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `study_sessions`
--

LOCK TABLES `study_sessions` WRITE;
/*!40000 ALTER TABLE `study_sessions` DISABLE KEYS */;
/*!40000 ALTER TABLE `study_sessions` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `vocabulary`
--

DROP TABLE IF EXISTS `vocabulary`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `vocabulary` (
  `id_vocabulary` int(11) NOT NULL AUTO_INCREMENT,
  `word` varchar(100) NOT NULL,
  `reading` varchar(150) DEFAULT NULL,
  `meaning` text NOT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id_vocabulary`),
  KEY `idx_vocabulary_jlpt` (`jlpt_level`),
  KEY `idx_vocabulary_status` (`status`),
  KEY `idx_vocabulary_word` (`word`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `vocabulary`
--

LOCK TABLES `vocabulary` WRITE;
/*!40000 ALTER TABLE `vocabulary` DISABLE KEYS */;
/*!40000 ALTER TABLE `vocabulary` ENABLE KEYS */;
UNLOCK TABLES;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-08-26  7:18:58
