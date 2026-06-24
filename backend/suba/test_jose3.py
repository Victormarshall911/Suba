from jose import jwt
import base64

header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode('utf-8').rstrip('=')
payload = base64.urlsafe_b64encode(b'{"sub":"1234567890"}').decode('utf-8').rstrip('=')
token = f"{header}.{payload}.fakesig"

try:
    jwt.decode(token, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.fakesecret", algorithms=["HS256"])
except Exception as e:
    print(repr(e))
