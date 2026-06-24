import asyncio
import asyncpg

async def test_conn():
    try:
        conn = await asyncpg.connect('postgresql://postgres.etqmvvjdsjzxcclwqwws:boboandchuka77@aws-0-eu-west-1.pooler.supabase.com:6543/postgres', timeout=5)
        print("Connected!")
        await conn.close()
    except Exception as e:
        print(f"Error: {e}")

asyncio.run(test_conn())
