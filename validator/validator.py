# validator.py
from fastapi import FastAPI
import sqlite3, re

app = FastAPI()

FORBIDDEN = re.compile(r"(;|INSERT|UPDATE|DELETE|ATTACH|PRAGMA|DROP|ALTER)", re.I)

@app.post("/validate")
def validate(payload: dict):
    sql = payload.get("sql", "")
    seed_sql = payload.get("seed_sql", "")

    # Block dangerous SQL
    if FORBIDDEN.search(sql):
        return {"verdict": "error", "message": "forbidden keywords"}

    # Create new in-memory SQLite DB for this request
    conn = sqlite3.connect(":memory:")
    cur = conn.cursor()

    try:
        # Seed with tiny dataset (from Supabase questions table)
        if seed_sql:
            cur.executescript(seed_sql)

        # Run player query
        cur.execute(sql)
        rows = cur.fetchmany(200)

        return {"verdict": "ok", "rows": rows}

    except Exception as e:
        return {"verdict": "error", "message": str(e)}

    finally:
        conn.close()
