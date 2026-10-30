# ER Diagram and Relational Schema

The diagram is written in Mermaid, so GitHub and VS Code (with a Mermaid extension) render it automatically. For the report, paste it into https://mermaid.live and export it as PNG or SVG.

```mermaid
erDiagram
    USERS ||--o{ BOOKMARKS : "saves"
    PAPERS ||--o{ BOOKMARKS : "is saved in"
    CONFERENCES |o--o{ PAPERS : "publishes"
    PAPERS ||--o{ PAPER_AUTHORS : "has"
    AUTHORS ||--o{ PAPER_AUTHORS : "writes"
    PAPERS ||--o{ CITATIONS : "cites (citing)"
    PAPERS ||--o{ CITATIONS : "is cited by (cited)"
    USERS |o--o{ AUDIT_LOG : "performed by"

    USERS {
        int user_id PK
        text name
        text email UK "lowercase"
        text password_hash
        text role "researcher | admin"
        timestamptz created_at
    }
    CONFERENCES {
        int conference_id PK
        text name "UK with year"
        text acronym
        int year "UK with name"
        text location
    }
    PAPERS {
        int paper_id PK
        text title
        text abstract
        int year
        text doi UK
        int conference_id FK "ON DELETE SET NULL"
        int citation_count "trigger-maintained, >= 0"
        text embedding_status "pending | done | failed"
        text openalex_id UK
        timestamptz created_at
        tsvector search_tsv "generated: title A + abstract B"
    }
    AUTHORS {
        int author_id PK
        text name
        text affiliation
        text openalex_id UK
    }
    PAPER_AUTHORS {
        int paper_id PK,FK "CASCADE"
        int author_id PK,FK "CASCADE"
        int author_order "UK with paper_id, >= 1"
    }
    CITATIONS {
        int citing_paper_id PK,FK "CASCADE"
        int cited_paper_id PK,FK "CASCADE, <> citing"
    }
    BOOKMARKS {
        int user_id PK,FK "CASCADE"
        int paper_id PK,FK "CASCADE"
        timestamptz created_at
    }
    AUDIT_LOG {
        int log_id PK
        text action
        int paper_id "not an FK on purpose"
        int admin_id FK "ON DELETE SET NULL"
        timestamptz logged_at
    }
```

## Relationships

| Relationship | Type | How it is stored |
|---|---|---|
| Conference publishes Paper | 1 : N (optional on the paper side) | `papers.conference_id` FK, `ON DELETE SET NULL` |
| Paper written by Author | M : N | Junction table `paper_authors`, plus `author_order` |
| Paper cites Paper | M : N, recursive (self-referencing) | Junction table `citations`, with two FKs to `papers` |
| User bookmarks Paper | M : N | Junction table `bookmarks`, plus `created_at` |
| Admin deletes Paper (logged) | 1 : N | `audit_log.admin_id` FK; `paper_id` is kept without an FK |

## Normalisation notes (up to 3NF)

- **1NF.** Every column holds a single value. Authors and citations are not stored as lists inside a paper row (no `authors TEXT[]`); each one gets its own row in `paper_authors` or `citations`. `search_tsv` is a derived search index computed by the database, not user data.
- **2NF.** Every table with a composite key (`paper_authors`, `citations`, `bookmarks`) has no attribute that depends on only part of the key:
  - `author_order` depends on the pair (paper, author).
  - `created_at` on a bookmark depends on the pair (user, paper).
  - Author details (name, affiliation) live in `authors`, not in `paper_authors`.
- **3NF.** No non-key attribute depends on another non-key attribute:
  - Conference name, acronym and location are stored once in `conferences`. Papers only carry `conference_id`, so a conference rename is a one-row update.
  - User role and email live only in `users`. Bookmarks reference the user by id.
- **Controlled redundancy: `papers.citation_count`.** This equals `COUNT(*)` of matching `citations` rows. It is a deliberate denormalisation for read speed: search results and the dashboard sort by it constantly. Triggers keep it correct, so it can never disagree with the `citations` table. A CHECK keeps it from going below 0.
