-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Servidor: 127.0.0.1
-- Tiempo de generación: 29-08-2026 a las 19:47:16
-- Versión del servidor: 12.3.3-MariaDB
-- Versión de PHP: 8.0.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Base de datos: `jlt`
--

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `grammar_points`
--

CREATE TABLE `grammar_points` (
  `id_grammar` int(11) NOT NULL,
  `grammar_point` varchar(100) NOT NULL,
  `meaning` varchar(255) NOT NULL,
  `structure` text DEFAULT NULL,
  `example` text DEFAULT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `grammar_points`
--

INSERT INTO `grammar_points` (`id_grammar`, `grammar_point`, `meaning`, `structure`, `example`, `jlpt_level`, `status`, `notes`, `created_at`, `updated_at`) VALUES
(2, '〜です', 'polite copula; is/am/are', 'Noun + です', '私は学生です。', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(3, '〜ます', 'polite verb ending', 'Verb stem + ます', '毎日、日本語を勉強します。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(4, '〜ません', 'polite negative verb ending', 'Verb stem + ません', '今日は学校へ行きません。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(5, '〜ました', 'polite past verb ending', 'Verb stem + ました', '昨日、本を読みました。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(6, '〜たい', 'want to do', 'Verb stem + たい', '日本へ行きたいです。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(7, '〜てください', 'please do', 'Verb て-form + ください', '本を読んでください。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(8, '〜てもいい', 'may; it is okay to', 'Verb て-form + もいい', 'ここで水を飲んでもいいです。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(9, '〜てはいけない', 'must not; may not', 'Verb て-form + はいけない', 'ここで話してはいけません。', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(10, '〜から', 'because; since', 'Clause + から', '明日は学校がありますから、早く寝ます。', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45');

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `kanji`
--

CREATE TABLE `kanji` (
  `id_kanji` int(11) NOT NULL,
  `character_kanji` varchar(4) NOT NULL,
  `meaning` varchar(255) NOT NULL,
  `onyomi` varchar(255) DEFAULT NULL,
  `kunyomi` varchar(255) DEFAULT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `kanji`
--

INSERT INTO `kanji` (`id_kanji`, `character_kanji`, `meaning`, `onyomi`, `kunyomi`, `jlpt_level`, `status`, `notes`, `created_at`, `updated_at`) VALUES
(2, '一', 'one', 'イチ, イツ', 'ひと, ひと.つ', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(3, '二', 'two', 'ニ', 'ふた, ふた.つ', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(4, '三', 'three', 'サン', 'み, み.つ', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(5, '四', 'four', 'シ', 'よん, よ, よ.つ', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(6, '五', 'five', 'ゴ', 'いつ, いつ.つ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(7, '六', 'six', 'ロク', 'む, む.つ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(8, '七', 'seven', 'シチ', 'なな, なな.つ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(9, '八', 'eight', 'ハチ', 'や, や.つ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(10, '九', 'nine', 'キュウ, ク', 'ここの, ここの.つ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(11, '十', 'ten', 'ジュウ, ジッ', 'とお', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(12, '人', 'person', 'ジン, ニン', 'ひと', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(13, '日', 'day; sun', 'ニチ, ジツ', 'ひ, か', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(14, '月', 'month; moon', 'ゲツ, ガツ', 'つき', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(15, '火', 'fire', 'カ', 'ひ', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(16, '水', 'water', 'スイ', 'みず', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(17, '木', 'tree; wood', 'モク, ボク', 'き', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(18, '金', 'gold; money', 'キン', 'かね', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(19, '土', 'earth; soil', 'ド, ト', 'つち', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(20, '山', 'mountain', 'サン', 'やま', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(21, '川', 'river', 'セン', 'かわ', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(22, '学', 'study; learning', 'ガク', 'まな.ぶ', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(23, '校', 'school', 'コウ', NULL, 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(24, '先', 'previous; ahead', 'セン', 'さき', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(25, '生', 'life; birth', 'セイ, ショウ', 'い.きる, う.まれる', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(26, '年', 'year', 'ネン', 'とし', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(27, '時', 'time; hour', 'ジ', 'とき', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(28, '分', 'minute; part', 'ブン, フン, プン', 'わ.かる', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(29, '今', 'now', 'コン', 'いま', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(30, '毎', 'every', 'マイ', NULL, 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(31, '上', 'up; above', 'ジョウ', 'うえ, あ.がる', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(32, '下', 'down; below', 'カ, ゲ', 'した, さ.がる', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(33, '中', 'inside; middle', 'チュウ', 'なか', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(34, '大', 'big', 'ダイ, タイ', 'おお.きい', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(35, '小', 'small', 'ショウ', 'ちい.さい, こ', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(36, '本', 'book; origin', 'ホン', 'もと', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(37, '語', 'language; word', 'ゴ', 'かた.る', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(38, '食', 'eat; food', 'ショク', 'た.べる', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(39, '飲', 'drink', 'イン', 'の.む', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(40, '行', 'go', 'コウ, ギョウ', 'い.く, おこな.う', 'N5', 'Familiar', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(41, '来', 'come', 'ライ', 'く.る', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(42, '見', 'see', 'ケン', 'み.る', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(43, '聞', 'hear; listen; ask', 'ブン, モン', 'き.く', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(44, '話', 'talk; story', 'ワ', 'はな.す, はなし', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(45, '読', 'read', 'ドク', 'よ.む', 'N5', 'New', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44'),
(46, '書', 'write', 'ショ', 'か.く', 'N5', 'Learning', 'N5 functional test data', '2026-08-29 17:27:44', '2026-08-29 17:27:44');

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `kanji_vocabulary`
--

CREATE TABLE `kanji_vocabulary` (
  `id_kanji` int(11) NOT NULL,
  `id_vocabulary` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `kanji_vocabulary`
--

INSERT INTO `kanji_vocabulary` (`id_kanji`, `id_vocabulary`) VALUES
(2, 3),
(3, 4),
(4, 5),
(2, 6),
(12, 6),
(3, 7),
(12, 7),
(13, 8),
(36, 8),
(13, 9),
(36, 9),
(37, 9),
(22, 10),
(25, 10),
(24, 11),
(25, 11),
(22, 12),
(23, 12),
(22, 13),
(34, 13),
(26, 14),
(29, 14),
(13, 15),
(29, 15),
(13, 16),
(30, 16),
(14, 17),
(30, 17),
(26, 18),
(30, 18),
(27, 19),
(2, 20),
(27, 20),
(28, 21),
(16, 22),
(20, 23),
(21, 24),
(36, 25),
(34, 26),
(35, 27),
(38, 28),
(39, 29),
(40, 30),
(41, 31),
(42, 32),
(43, 33),
(44, 34),
(45, 35),
(46, 36),
(14, 37),
(15, 38),
(16, 39),
(17, 40),
(18, 41),
(19, 42),
(13, 43);

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `session_grammar`
--

CREATE TABLE `session_grammar` (
  `id_session` int(11) NOT NULL,
  `id_grammar` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `session_grammar`
--

INSERT INTO `session_grammar` (`id_session`, `id_grammar`) VALUES
(7, 2),
(14, 2),
(7, 3),
(9, 3),
(14, 3),
(7, 4),
(14, 4),
(13, 5),
(14, 5),
(9, 6),
(13, 6),
(14, 6),
(13, 7),
(13, 8),
(9, 10),
(14, 10);

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `session_kanji`
--

CREATE TABLE `session_kanji` (
  `id_session` int(11) NOT NULL,
  `id_kanji` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `session_kanji`
--

INSERT INTO `session_kanji` (`id_session`, `id_kanji`) VALUES
(6, 2),
(6, 3),
(6, 4),
(6, 5),
(6, 6),
(6, 7),
(6, 8),
(6, 9),
(6, 10),
(6, 11),
(6, 12),
(9, 13),
(12, 13),
(14, 13),
(12, 14),
(12, 15),
(12, 16),
(12, 17),
(12, 18),
(12, 19),
(9, 22),
(9, 23),
(14, 29),
(14, 30),
(9, 36),
(9, 37),
(9, 38),
(14, 38),
(9, 39),
(14, 39),
(9, 40),
(14, 40),
(14, 41),
(14, 42),
(14, 43),
(14, 44),
(12, 45),
(14, 45),
(12, 46),
(14, 46);

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `session_vocabulary`
--

CREATE TABLE `session_vocabulary` (
  `id_session` int(11) NOT NULL,
  `id_vocabulary` int(11) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `session_vocabulary`
--

INSERT INTO `session_vocabulary` (`id_session`, `id_vocabulary`) VALUES
(5, 8),
(5, 9),
(14, 9),
(5, 10),
(5, 11),
(5, 12),
(11, 12),
(11, 13),
(11, 14),
(9, 15),
(11, 15),
(9, 16),
(14, 16),
(9, 19),
(11, 19),
(11, 20),
(11, 21),
(9, 28),
(14, 28),
(9, 29),
(14, 29),
(9, 30),
(14, 30),
(14, 31),
(14, 32),
(14, 33),
(14, 34),
(12, 35),
(14, 35),
(12, 36),
(14, 36),
(12, 37),
(12, 38),
(12, 39),
(12, 40),
(12, 41),
(12, 42),
(12, 43);

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `study_sessions`
--

CREATE TABLE `study_sessions` (
  `id_session` int(11) NOT NULL,
  `session_date` date NOT NULL,
  `duration_minutes` int(11) NOT NULL CHECK (`duration_minutes` > 0),
  `category` varchar(20) NOT NULL CHECK (`category` in ('Grammar','Vocabulary','Kanji','Reading','Listening','Speaking','Writing','Mixed')),
  `resource` varchar(255) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `study_sessions`
--

INSERT INTO `study_sessions` (`id_session`, `session_date`, `duration_minutes`, `category`, `resource`, `notes`, `created_at`, `updated_at`) VALUES
(1, '2026-08-28', 30, 'Mixed', 'Genki', 'This only a test, not a real session.', '2026-08-29 01:01:14', '2026-08-29 01:01:14'),
(2, '2026-08-28', 45, 'Vocabulary', 'Genki', 'Review', '2026-08-29 01:08:03', '2026-08-29 01:08:03'),
(5, '2026-08-20', 35, 'Vocabulary', 'Genki I - Lesson 1', 'Reviewed greetings and basic nouns. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(6, '2026-08-21', 30, 'Kanji', 'Ringotan', 'Practiced numbers and 人. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(7, '2026-08-22', 45, 'Grammar', 'Genki I', 'Practiced です and ます forms. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(8, '2026-08-23', 25, 'Listening', 'Japanese beginner podcast', 'Short listening session. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(9, '2026-08-24', 50, 'Mixed', 'Genki I + notes', 'Vocabulary, kanji and grammar review. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(10, '2026-08-25', 40, 'Reading', 'NHK Easy sample text', 'Read a short beginner passage. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(11, '2026-08-26', 30, 'Vocabulary', 'JLT review', 'Reviewed school and time vocabulary. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(12, '2026-08-27', 55, 'Mixed', 'JLT review', 'Weekday vocabulary and verb review. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(13, '2026-08-28', 20, 'Writing', 'Notebook', 'Wrote example sentences using N5 grammar. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(14, '2026-08-29', 60, 'Mixed', 'JLT V1', 'Full V1 real-data functional test session. N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45');

-- --------------------------------------------------------

--
-- Estructura de tabla para la tabla `vocabulary`
--

CREATE TABLE `vocabulary` (
  `id_vocabulary` int(11) NOT NULL,
  `word` varchar(100) NOT NULL,
  `reading` varchar(150) DEFAULT NULL,
  `meaning` text NOT NULL,
  `jlpt_level` varchar(2) DEFAULT NULL CHECK (`jlpt_level` in ('N5','N4','N3','N2','N1') or `jlpt_level` is null),
  `status` varchar(20) NOT NULL DEFAULT 'New' CHECK (`status` in ('New','Learning','Familiar','Mastered')),
  `notes` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Volcado de datos para la tabla `vocabulary`
--

INSERT INTO `vocabulary` (`id_vocabulary`, `word`, `reading`, `meaning`, `jlpt_level`, `status`, `notes`, `created_at`, `updated_at`) VALUES
(3, '一つ', 'ひとつ', 'one thing', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(4, '二つ', 'ふたつ', 'two things', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(5, '三つ', 'みっつ', 'three things', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(6, '一人', 'ひとり', 'one person', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(7, '二人', 'ふたり', 'two people', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(8, '日本', 'にほん', 'Japan', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(9, '日本語', 'にほんご', 'Japanese language', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(10, '学生', 'がくせい', 'student', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(11, '先生', 'せんせい', 'teacher', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(12, '学校', 'がっこう', 'school', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(13, '大学', 'だいがく', 'university', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(14, '今年', 'ことし', 'this year', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(15, '今日', 'きょう', 'today', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(16, '毎日', 'まいにち', 'every day', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(17, '毎月', 'まいげつ', 'every month', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(18, '毎年', 'まいとし', 'every year', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(19, '時間', 'じかん', 'time; hours', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(20, '一時間', 'いちじかん', 'one hour', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(21, '十分', 'じゅっぷん', 'ten minutes', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(22, '水', 'みず', 'water', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(23, '山', 'やま', 'mountain', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(24, '川', 'かわ', 'river', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(25, '本', 'ほん', 'book', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(26, '大きい', 'おおきい', 'big', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(27, '小さい', 'ちいさい', 'small', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(28, '食べる', 'たべる', 'to eat', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(29, '飲む', 'のむ', 'to drink', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(30, '行く', 'いく', 'to go', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(31, '来る', 'くる', 'to come', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(32, '見る', 'みる', 'to see; to watch', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(33, '聞く', 'きく', 'to hear; to listen; to ask', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(34, '話す', 'はなす', 'to speak; to talk', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(35, '読む', 'よむ', 'to read', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(36, '書く', 'かく', 'to write', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(37, '月曜日', 'げつようび', 'Monday', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(38, '火曜日', 'かようび', 'Tuesday', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(39, '水曜日', 'すいようび', 'Wednesday', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(40, '木曜日', 'もくようび', 'Thursday', 'N5', 'New', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(41, '金曜日', 'きんようび', 'Friday', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(42, '土曜日', 'どようび', 'Saturday', 'N5', 'Learning', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45'),
(43, '日曜日', 'にちようび', 'Sunday', 'N5', 'Familiar', 'N5 realistic testing batch', '2026-08-29 17:27:45', '2026-08-29 17:27:45');

--
-- Índices para tablas volcadas
--

--
-- Indices de la tabla `grammar_points`
--
ALTER TABLE `grammar_points`
  ADD PRIMARY KEY (`id_grammar`),
  ADD UNIQUE KEY `grammar_point` (`grammar_point`),
  ADD KEY `idx_grammar_jlpt` (`jlpt_level`),
  ADD KEY `idx_grammar_status` (`status`);

--
-- Indices de la tabla `kanji`
--
ALTER TABLE `kanji`
  ADD PRIMARY KEY (`id_kanji`),
  ADD UNIQUE KEY `character_kanji` (`character_kanji`),
  ADD KEY `idx_kanji_jlpt` (`jlpt_level`),
  ADD KEY `idx_kanji_status` (`status`);

--
-- Indices de la tabla `kanji_vocabulary`
--
ALTER TABLE `kanji_vocabulary`
  ADD PRIMARY KEY (`id_kanji`,`id_vocabulary`),
  ADD KEY `id_vocabulary` (`id_vocabulary`);

--
-- Indices de la tabla `session_grammar`
--
ALTER TABLE `session_grammar`
  ADD PRIMARY KEY (`id_session`,`id_grammar`),
  ADD KEY `id_grammar` (`id_grammar`);

--
-- Indices de la tabla `session_kanji`
--
ALTER TABLE `session_kanji`
  ADD PRIMARY KEY (`id_session`,`id_kanji`),
  ADD KEY `id_kanji` (`id_kanji`);

--
-- Indices de la tabla `session_vocabulary`
--
ALTER TABLE `session_vocabulary`
  ADD PRIMARY KEY (`id_session`,`id_vocabulary`),
  ADD KEY `id_vocabulary` (`id_vocabulary`);

--
-- Indices de la tabla `study_sessions`
--
ALTER TABLE `study_sessions`
  ADD PRIMARY KEY (`id_session`),
  ADD KEY `idx_sessions_date` (`session_date`),
  ADD KEY `idx_sessions_category` (`category`);

--
-- Indices de la tabla `vocabulary`
--
ALTER TABLE `vocabulary`
  ADD PRIMARY KEY (`id_vocabulary`),
  ADD KEY `idx_vocabulary_jlpt` (`jlpt_level`),
  ADD KEY `idx_vocabulary_status` (`status`),
  ADD KEY `idx_vocabulary_word` (`word`);

--
-- AUTO_INCREMENT de las tablas volcadas
--

--
-- AUTO_INCREMENT de la tabla `grammar_points`
--
ALTER TABLE `grammar_points`
  MODIFY `id_grammar` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;

--
-- AUTO_INCREMENT de la tabla `kanji`
--
ALTER TABLE `kanji`
  MODIFY `id_kanji` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=47;

--
-- AUTO_INCREMENT de la tabla `study_sessions`
--
ALTER TABLE `study_sessions`
  MODIFY `id_session` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15;

--
-- AUTO_INCREMENT de la tabla `vocabulary`
--
ALTER TABLE `vocabulary`
  MODIFY `id_vocabulary` int(11) NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=44;

--
-- Restricciones para tablas volcadas
--

--
-- Filtros para la tabla `kanji_vocabulary`
--
ALTER TABLE `kanji_vocabulary`
  ADD CONSTRAINT `kanji_vocabulary_ibfk_1` FOREIGN KEY (`id_kanji`) REFERENCES `kanji` (`id_kanji`) ON DELETE CASCADE,
  ADD CONSTRAINT `kanji_vocabulary_ibfk_2` FOREIGN KEY (`id_vocabulary`) REFERENCES `vocabulary` (`id_vocabulary`) ON DELETE CASCADE;

--
-- Filtros para la tabla `session_grammar`
--
ALTER TABLE `session_grammar`
  ADD CONSTRAINT `session_grammar_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_grammar_ibfk_2` FOREIGN KEY (`id_grammar`) REFERENCES `grammar_points` (`id_grammar`) ON DELETE CASCADE;

--
-- Filtros para la tabla `session_kanji`
--
ALTER TABLE `session_kanji`
  ADD CONSTRAINT `session_kanji_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_kanji_ibfk_2` FOREIGN KEY (`id_kanji`) REFERENCES `kanji` (`id_kanji`) ON DELETE CASCADE;

--
-- Filtros para la tabla `session_vocabulary`
--
ALTER TABLE `session_vocabulary`
  ADD CONSTRAINT `session_vocabulary_ibfk_1` FOREIGN KEY (`id_session`) REFERENCES `study_sessions` (`id_session`) ON DELETE CASCADE,
  ADD CONSTRAINT `session_vocabulary_ibfk_2` FOREIGN KEY (`id_vocabulary`) REFERENCES `vocabulary` (`id_vocabulary`) ON DELETE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
