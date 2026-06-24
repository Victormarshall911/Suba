from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn
import asyncio

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected error occurred"},
    )

@app.post("/crash")
async def crash():
    raise ValueError("Oops!")

async def test():
    import httpx
    # Start server in background
    config = uvicorn.Config(app, host="127.0.0.1", port=8003, log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    await asyncio.sleep(2)
    
    async with httpx.AsyncClient() as client:
        resp = await client.post("http://127.0.0.1:8003/crash", headers={"Origin": "https://suba-rho.vercel.app"})
        print("Status:", resp.status_code)
        print("Headers:", dict(resp.headers))
    
    server.should_exit = True
    await task

if __name__ == "__main__":
    asyncio.run(test())
