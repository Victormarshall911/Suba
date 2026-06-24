from jose.exceptions import JWKError, JWTError
print(issubclass(JWKError, JWTError))
