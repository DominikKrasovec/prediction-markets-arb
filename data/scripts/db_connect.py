"""
db_connect.py — lightweight PostgreSQL helper for the data/ notebooks and scripts.

Reads connection settings from the project .env file (PG_HOST, PG_PORT,
PG_DATABASE, PG_USER, PG_PASSWORD) with the same defaults as the TypeScript
pool (packages/db/src/pool.ts), so both share identical connection semantics.

Usage:
    from scripts.db_connect import query_df, read_sql_file

    df = query_df("SELECT * FROM markets LIMIT 10")

    # or read a pre-written SQL file from data/sql/
    df = query_df(read_sql_file("discovery_daily.sql"),
                  params={"limit_days": 90})
"""

from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import psycopg2
from dotenv import load_dotenv

# ── Load .env from project root (two levels up from data/scripts/) ───────────
_HERE = Path(__file__).resolve()
_PROJECT_ROOT = _HERE.parent.parent.parent   # data/scripts/ → data/ → project root
load_dotenv(_PROJECT_ROOT / ".env")

# ── Connection params (mirror TS defaults) ────────────────────────────────────
_DSN: dict = {
    "host":     os.getenv("PG_HOST",     "localhost"),
    "port":     int(os.getenv("PG_PORT", "5433")),   # docker maps 5433 → 5432
    "dbname":   os.getenv("PG_DATABASE", "prediction_arb"),
    "user":     os.getenv("PG_USER",     "arb"),
    "password": os.getenv("PG_PASSWORD", "arb_local_dev"),
}


def get_connection() -> psycopg2.extensions.connection:
    """Return a new psycopg2 connection. Caller is responsible for closing it."""
    return psycopg2.connect(**_DSN)


def query_df(sql: str, params: dict | None = None) -> pd.DataFrame:
    """
    Execute *sql* and return the result as a pandas DataFrame.

    Named parameters in *sql* use %(name)s syntax (psycopg2 default).
    Pass them as a plain dict via *params*.
    """
    conn = get_connection()
    try:
        df = pd.read_sql_query(sql, conn, params=params)
    finally:
        conn.close()
    return df


# ── SQL file loader ───────────────────────────────────────────────────────────
_SQL_DIR = _HERE.parent.parent / "sql"   # data/sql/


def read_sql_file(filename: str) -> str:
    """
    Read a .sql file from data/sql/ and return its contents as a string.

    Example:
        sql = read_sql_file("discovery_daily.sql")
    """
    path = _SQL_DIR / filename
    if not path.exists():
        raise FileNotFoundError(f"SQL file not found: {path}")
    return path.read_text(encoding="utf-8")
