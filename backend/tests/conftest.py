import os

os.environ.setdefault("ENV", "dev")
os.environ.setdefault("SECRET_KEY", "test-secret-that-is-at-least-32-characters")
os.environ.setdefault("DATABASE_URL", "postgresql://nr:nr@localhost:5432/note_rag")
os.environ.setdefault("GOOGLE_CLIENT_ID", "test")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "test")
os.environ.setdefault("GEMINI_API_KEY", "test")
