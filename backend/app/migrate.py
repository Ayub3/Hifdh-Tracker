"""Initial schema bootstrap. Replace with versioned migrations before evolving a deployed schema."""
from .database import Base, engine

if __name__ == "__main__":
    Base.metadata.create_all(engine)
    print("Initial schema ready")
