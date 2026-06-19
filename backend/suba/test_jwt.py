import sys
from jose import jwt, JWTError

token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV0cW12dmpkc2p6eGNjbHdxd3dzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODk3MzMsImV4cCI6MjA5NzM2NTczM30.wDDMZ9gpIA72Co91O6Pu30y5_hhx0-hnsPYVuFZ2lE4'
secret = 'Tx8ofxuYRpWj5TmW7s6s8VAymG447X9Y08nlFa+NIbyyV09NNFDjdHEcD+MopuZmLOwf3Q6nbDOq7ikwerCcgA=='

try:
    payload = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_aud": False})
    print("Success:", payload)
except JWTError as e:
    print("Failed with raw string:", e)

