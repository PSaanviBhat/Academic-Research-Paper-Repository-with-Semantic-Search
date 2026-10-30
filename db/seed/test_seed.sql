-- =====================================================================
-- Small hand-made dataset for tests and demos (made-up papers).
-- Loaded by the tests inside a transaction that is rolled back.
-- To load it for a manual demo:  bash scripts/psql.sh -f /db/seed/test_seed.sql
--
-- Expected citation counts after loading (kept by the triggers):
--   P1 = 4, P2 = 3, P3 = 2, P4 = 1, P5 = 1, P6 = 0
-- =====================================================================

INSERT INTO conferences (name, acronym, year, location) VALUES
  ('Conference on Neural Information Processing Systems', 'NeurIPS', 2017, 'Long Beach'),
  ('Annual Meeting of the Association for Computational Linguistics', 'ACL', 2019, 'Florence'),
  ('Conference on Empirical Methods in Natural Language Processing', 'EMNLP', 2020, 'Online');

INSERT INTO papers (title, abstract, year, doi, conference_id)
SELECT v.title, v.abstract, v.year, v.doi, c.conference_id
FROM (VALUES
  ('P1 Self-Attention Networks for Sequence Transduction',
   'We propose a sequence transduction model based solely on attention, removing recurrence and convolution entirely.',
   2017, '10.5555/seed.1', 'NeurIPS'),
  ('P2 Bidirectional Transformer Pre-training for Language Understanding',
   'Deep bidirectional representations are pre-trained from unlabelled text and fine-tuned for downstream tasks.',
   2019, '10.5555/seed.2', 'ACL'),
  ('P3 Dense Passage Retrieval with Dual Encoders',
   'Open-domain question answering retrieves passages using dense vector representations learned by two encoders.',
   2020, '10.5555/seed.3', 'EMNLP'),
  ('P4 Multilingual Neural Machine Translation at Scale',
   'A single translation model is trained on many language pairs and transfers knowledge to low-resource languages.',
   2019, '10.5555/seed.4', 'ACL'),
  ('P5 Sentence Embeddings with Siamese Networks',
   'Siamese and triplet network structures produce semantically meaningful sentence embeddings for similarity search.',
   2020, '10.5555/seed.5', 'EMNLP'),
  ('P6 A Survey of Pretrained Language Models',
   'We review pretrained language models, their training objectives, and applications across natural language processing.',
   2020, '10.5555/seed.6', NULL)
) AS v(title, abstract, year, doi, acronym)
LEFT JOIN conferences c ON c.acronym = v.acronym;

INSERT INTO authors (name, affiliation) VALUES
  ('Asha Rao', 'Indian Institute of Science'),
  ('Ben Carter', 'MIT'),
  ('Chen Wei', 'Tsinghua University'),
  ('Divya Nair', 'PES University'),
  ('Elena Rossi', NULL),
  ('Farah Khan', 'IIT Bombay');   -- has no papers: tests LEFT JOINs in the views

-- (paper prefix, author, position in byline)
INSERT INTO paper_authors (paper_id, author_id, author_order)
SELECT p.paper_id, a.author_id, v.ord
FROM (VALUES
  ('P1', 'Asha Rao', 1),   ('P1', 'Ben Carter', 2),
  ('P2', 'Ben Carter', 1), ('P2', 'Asha Rao', 2),
  ('P3', 'Chen Wei', 1),
  ('P4', 'Divya Nair', 1), ('P4', 'Chen Wei', 2), ('P4', 'Elena Rossi', 3),
  ('P5', 'Divya Nair', 1),
  ('P6', 'Elena Rossi', 1), ('P6', 'Asha Rao', 2)
) AS v(paper, author, ord)
JOIN papers p  ON p.title LIKE v.paper || ' %'
JOIN authors a ON a.name = v.author;

-- (citing paper, cited paper)
INSERT INTO citations (citing_paper_id, cited_paper_id)
SELECT citing.paper_id, cited.paper_id
FROM (VALUES
  ('P2', 'P1'), ('P3', 'P1'), ('P3', 'P2'), ('P4', 'P1'),
  ('P5', 'P2'), ('P5', 'P3'),
  ('P6', 'P1'), ('P6', 'P2'), ('P6', 'P3'), ('P6', 'P4'), ('P6', 'P5')
) AS v(citing, cited)
JOIN papers citing ON citing.title LIKE v.citing || ' %'
JOIN papers cited  ON cited.title  LIKE v.cited  || ' %';
