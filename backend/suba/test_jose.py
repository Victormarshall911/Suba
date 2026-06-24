from jose import jwt
import base64
import json

header = base64.urlsafe_b64encode(b'{"alg":"RS256","typ":"JWT"}').decode('utf-8').rstrip('=')
payload = base64.urlsafe_b64encode(b'{"sub":"1234567890"}').decode('utf-8').rstrip('=')
token = f"{header}.{payload}.fakesig"

try:
    jwt.decode(token, "some-secret", algorithms=["RS256"])
except Exception as e:
    print(repr(e))
