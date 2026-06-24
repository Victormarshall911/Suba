import asyncio
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy import select
from app.models.user import User
from app.models.wallet import Wallet
from app.core.security import hash_password

async def run():
    engine = create_async_engine('postgresql+asyncpg://postgres.etqmvvjdsjzxcclwqwws:boboandchuka77@aws-0-eu-west-1.pooler.supabase.com:6543/postgres')
    session_maker = async_sessionmaker(engine, expire_on_commit=False)
    
    async with session_maker() as db:
        email = "testcrash@test.com"
        
        print("Checking email...")
        existing_email = await db.execute(select(User).where(User.email == email))
        if existing_email.scalar_one_or_none() is not None:
            print("Exists")
            return
            
        print("Hashing pw...")
        hashed_pw = hash_password("Password123")
        
        new_user = User(
            email=email,
            phone_number="08030000000",
            full_name="Crash Test",
            password_hash=hashed_pw,
        )
        db.add(new_user)
        
        print("Flushing...")
        await db.flush()
        
        new_wallet = Wallet(user_id=new_user.id, balance=0.00)
        db.add(new_wallet)
        
        print("Committing...")
        await db.commit()
        print("Success")

asyncio.run(run())
