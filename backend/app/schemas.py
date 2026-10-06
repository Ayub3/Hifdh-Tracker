from datetime import date
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, field_validator

class Credentials(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)
    @field_validator("email")
    @classmethod
    def normalise_email(cls, value):
        value = value.strip().lower()
        if value.count("@") != 1 or not all(value.split("@")) or any(c.isspace() for c in value):
            raise ValueError("Invalid email")
        return value

class PlanInput(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    daily_minutes: int = Field(ge=5, le=480)
    @field_validator("title")
    @classmethod
    def title_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Title cannot be blank")
        return value.strip()

class PlanOutput(PlanInput):
    model_config = ConfigDict(from_attributes=True)
    id: str

class SessionInput(BaseModel):
    kind: Literal["memorisation", "revision"]
    minutes: int = Field(ge=1, le=480)
    verses: int = Field(ge=1, le=1000)
    studied_on: date
    @field_validator("studied_on")
    @classmethod
    def no_future_date(cls, value):
        if value > date.today():
            raise ValueError("Study date cannot be in the future")
        return value

class SessionOutput(SessionInput):
    model_config = ConfigDict(from_attributes=True)
    id: str
    plan_id: str
