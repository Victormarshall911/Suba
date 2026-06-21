# Use the official lightweight Python image
FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Copy the requirements file from the backend folder
COPY backend/suba/requirements.txt .

# Install dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend code
COPY backend/suba/ .

# Expose the port (Render/Railway will inject the PORT environment variable)
EXPOSE 8000

# Start the application
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
