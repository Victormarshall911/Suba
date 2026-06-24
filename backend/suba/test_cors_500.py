from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/crash")
async def crash():
    raise ValueError("Oops!")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8002)
