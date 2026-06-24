import requests
import json
import base64

header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode('utf-8').rstrip('=')
payload = base64.urlsafe_b64encode(b'{"sub":"1234567890","name":"John Doe","iat":1516239022}').decode('utf-8').rstrip('=')
token = f"{header}.{payload}.fakesig"

url = "https://suba-backend.onrender.com/api/v1/auth/register"
headers = {"Content-Type": "application/json", "Origin": "https://suba-rho.vercel.app"}
data = {
    "email": "testspin4@test.com",
    "phone_number": "08031234567",
    "password": "SecurePass1",
    "full_name": "Test User",
    "supabase_token": token
}

try:
    response = requests.post(url, headers=headers, json=data, timeout=10)
    print("Status:", response.status_code)
    print("Body:", response.text)
except Exception as e:
    print("Error:", e)
