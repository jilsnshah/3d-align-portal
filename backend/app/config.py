from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(BACKEND_ROOT.parent / ".env", BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "3D Align Order Portal"

    # Postgres in production. SQLite default so the portal runs with no setup.
    database_url: str = f"sqlite:///{BACKEND_ROOT / 'dev.db'}"

    # Signs the session cookie. Override in every deployed environment.
    secret_key: str = "dev-secret-change-me"
    session_cookie_name: str = "align_session"
    session_max_age_seconds: int = 60 * 60 * 12
    cookie_secure: bool = False

    cors_origins: str = "http://localhost:5173"

    # The single staff account, seeded at startup.
    staff_email: str = "staff@3dalign.com"
    staff_password: str = "changeme"
    staff_name: str = "3D Align Lab"

    # "local" writes under storage_local_root. "drive" uses a Google service account.
    storage_backend: str = "local"
    storage_local_root: str = str(BACKEND_ROOT / "storage")
    drive_service_account_file: str = ""
    drive_root_folder_id: str = ""

    # Refrens invoicing. Left blank, invoicing stays disabled and says so.
    refrens_app_id: str = ""
    refrens_private_key: str = ""
    refrens_business_key: str = ""
    invoice_model_print_fee: float = 250.0

    # Dental council registry check on signup. Off by default: the registry is a
    # slow scraped endpoint and staff verify manually regardless.
    dci_check_enabled: bool = False

    max_upload_mb: int = 200

    # How long a deleted file stays recoverable in the recycle bin.
    trash_retention_days: int = 30

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
