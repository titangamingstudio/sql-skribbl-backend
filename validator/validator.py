from fastapi import FastAPI
import sqlite3, re

app = FastAPI()

# Block only dangerous keywords (not semicolons anymore)
FORBIDDEN = re.compile(r"(INSERT|UPDATE|DELETE|ATTACH|PRAGMA|DROP|ALTER)", re.I)

@app.post("/validate")
def validate(payload: dict):
    sql = payload.get("sql", "").strip()
    question_seed = payload.get("seed_sql", "")

    # ✅ Allow one trailing semicolon
    if sql.endswith(";"):
        sql = sql[:-1].strip()

    # ❌ Block dangerous commands
    if FORBIDDEN.search(sql):
        return {"verdict": "error", "message": "forbidden keywords"}

    # Create fresh in-memory DB for every validation
    conn = sqlite3.connect(":memory:", timeout=1)  # 1 second timeout
    cur = conn.cursor()

    try:
        # Load seed data for this question
        cur.executescript(question_seed)

        # Execute player query
        cur.execute(sql)

        # Limit rows returned
        rows = cur.fetchmany(200)

        # Convert to safe Python list
        return {"verdict": "ok", "rows": rows}

    except Exception as e:
        return {"verdict": "error", "message": str(e)}

    finally:
        conn.close()
