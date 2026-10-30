# Query-plan evidence: indexes, with and without

Measured on the loaded dataset: 4,000 papers and 37,988 citations, PostgreSQL 16.15 in Docker on the development laptop, on 30 Oct 2026.

Reproduce with:

```bash
bash scripts/psql.sh -f /db/evidence/explain_indexes.sql
```

The script runs each query **with** its index, then runs `BEGIN; DROP INDEX ...;`, repeats the query, and runs `ROLLBACK;`. The dropped index comes back untouched, so the experiment never changes the real database. `ANALYZE` runs first so the planner has fresh statistics, and a warm-up query makes both runs read from memory.

## Summary (average of 20 runs each)

| Query | With index | Without index | Speed-up | Plan with index → without |
|---|---:|---:|---:|---|
| Keyword search "neural machine translation" (320 matches) | 3.38 ms | 13.92 ms | **4.1×** | Bitmap Index Scan on `idx_papers_search_tsv` → Seq Scan |
| Keyword search "coreference resolution" (84 matches) | 0.55 ms | 11.54 ms | **20.9×** | Bitmap Index Scan → Seq Scan |
| "Cited by" lookup for the most-cited paper (530 rows of 37,988) | 0.27 ms | 2.09 ms | **7.7×** | Bitmap Index Scan on `idx_citations_cited_paper_id` → Seq Scan |

Single `EXPLAIN ANALYZE` runs of the first query: **4.4 ms with** the GIN index, reading 777 buffers (8 KB pages), against **13.9 ms without** it, reading **12,123 buffers**. That is 15.6 times fewer pages.

## Why it is faster

- **Without the index, PostgreSQL must check every paper.** The Seq Scan reads all 4,000 rows, including their stored `search_tsv` values, and tests `search_tsv @@ query` on each one. The plan says so directly: `Rows Removed by Filter: 3680`.
- **With the GIN index, it asks the index first.** GIN is an inverted index: for each word stem (`neural`, `machin`, `translat`) it stores the list of papers containing it. The Bitmap Index Scan intersects those lists, reading only 31 index pages, and returns exactly the 321 candidate rows. Only those rows are fetched from the table (Bitmap Heap Scan, 227 heap blocks).
- **The rarer the words, the bigger the gain.** "coreference resolution" matches only 84 papers, so the index skips about 98% of the table and the speed-up grows to 21×. The sequential scan costs the same however few rows match, because it always reads everything.
- **The gap grows with the data.** A Seq Scan grows linearly with the number of papers. An index lookup grows with the number of matches. At 4,000 papers the difference is milliseconds; at a million papers, the sequential scan would take seconds.
- **The B-tree on `citations(cited_paper_id)` follows the same idea.** The composite primary key `(citing_paper_id, cited_paper_id)` can only find rows by its *first* column. Without the extra index, "who cites paper X?" scans all 37,988 citation rows (`Rows Removed by Filter: 37458`). The citation-count triggers and the `ON DELETE CASCADE` from papers use the same lookup.

## Plan 1: keyword search WITH the GIN index

```
 Limit (actual time=4.413..4.416 rows=10 loops=1)
   Buffers: shared hit=777
   ->  Sort (actual time=4.412..4.413 rows=10 loops=1)
         Sort Key: (ts_rank_cd(papers.search_tsv, '''neural'' & ''machin'' & ''translat'''::tsquery)) DESC
         Sort Method: top-N heapsort  Memory: 25kB
         Buffers: shared hit=777
         ->  Bitmap Heap Scan on papers (actual time=0.445..4.330 rows=320 loops=1)
               Recheck Cond: (search_tsv @@ '''neural'' & ''machin'' & ''translat'''::tsquery)
               Heap Blocks: exact=227
               Buffers: shared hit=777
               ->  Bitmap Index Scan on idx_papers_search_tsv (actual time=0.166..0.167 rows=321 loops=1)
                     Index Cond: (search_tsv @@ '''neural'' & ''machin'' & ''translat'''::tsquery)
                     Buffers: shared hit=31
 Planning Time: 0.254 ms
 Execution Time: 4.441 ms
```

## Plan 2: the same query WITHOUT the GIN index

```
 Limit (actual time=13.926..13.928 rows=10 loops=1)
   Buffers: shared hit=12123
   ->  Sort (actual time=13.925..13.926 rows=10 loops=1)
         Sort Key: (ts_rank_cd(papers.search_tsv, '''neural'' & ''machin'' & ''translat'''::tsquery)) DESC
         Sort Method: top-N heapsort  Memory: 25kB
         Buffers: shared hit=12123
         ->  Seq Scan on papers (actual time=0.299..13.852 rows=320 loops=1)
               Filter: (search_tsv @@ '''neural'' & ''machin'' & ''translat'''::tsquery)
               Rows Removed by Filter: 3680
               Buffers: shared hit=12123
 Planning Time: 0.182 ms
 Execution Time: 13.941 ms
```

## Plan 3: "cited by" WITH the B-tree index

```
 Bitmap Heap Scan on citations (actual time=0.071..0.538 rows=530 loops=1)
   Recheck Cond: (cited_paper_id = 3)
   Heap Blocks: exact=163
   Buffers: shared hit=165
   ->  Bitmap Index Scan on idx_citations_cited_paper_id (actual time=0.040..0.041 rows=531 loops=1)
         Index Cond: (cited_paper_id = 3)
         Buffers: shared hit=2
 Planning Time: 0.175 ms
 Execution Time: 0.621 ms
```

## Plan 4: "cited by" WITHOUT the B-tree index

```
 Seq Scan on citations (actual time=0.009..2.495 rows=530 loops=1)
   Filter: (cited_paper_id = 3)
   Rows Removed by Filter: 37458
   Buffers: shared hit=169
 Planning Time: 0.089 ms
 Execution Time: 2.530 ms
```

## Reading the plans (for the viva)

- **`actual time=a..b`**: milliseconds until the first row (a) and until the last row (b) left that step.
- **`rows`**: rows that step actually produced.
- **`Buffers: shared hit=N`**: number of 8 KB pages read from PostgreSQL's memory cache. Fewer pages means less work.
- **Bitmap Index Scan, then Bitmap Heap Scan**: the index produces a bitmap of the matching table pages, and the heap scan then visits only those pages, in physical order.
- **Recheck Cond**: the heap scan re-checks each row against the condition. GIN results for full-text search can include false positives, and the bitmap may be lossy for very large result sets.
- **`Sort Method: top-N heapsort`**: because of `LIMIT 10`, PostgreSQL keeps only the 10 best scores while sorting instead of sorting all 320 rows.
