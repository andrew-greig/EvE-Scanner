from sqlalchemy import create_all, Column, Integer, String, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy import create_engine

Base = declarative_base()

class System(Base):
    __tablename__ = 'systems'
    id = Column(Integer, primary_key=True)
    name = Column(String)
    x = Column(Float)
    y = Column(Float)
    z = Column(Float)

class Token(Base):
    __tablename__ = 'tokens'
    character_id = Column(Integer, primary_key=True)
    refresh_token = Column(String)

engine = create_engine('sqlite:///eve_intel.db')
Base.metadata.create_all(engine)
