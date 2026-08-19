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

    # Server-side Google key, used for Distance Matrix (travel times) and
    # Geocoding (clinic coordinates). Leave empty and the scheduler falls back
    # to straight-line estimates and pincode centroids — it never blocks on it.
    # Restrict the key by IP and to those two APIs; it is not a browser key.
    google_maps_api_key: str = ""
    google_maps_timeout_seconds: float = 6.0

    # PESSIMISTIC schedules against a bad traffic day, so a technician is early
    # rather than late. BEST_GUESS packs more visits in and occasionally slips.
    google_traffic_model: str = "PESSIMISTIC"

    # Referrer-restricted key for the interactive route map. Embedded in the
    # page by design; the referrer restriction is what protects it.
    google_maps_browser_key: str = ""

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

    # Where the built frontend lives, so one process serves the app and the API.
    frontend_dist: str = ""

    # Refuses to start with development defaults when this is not "development".
    environment: str = "development"

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


UNSAFE_DEFAULTS = {
    "secret_key": "dev-secret-change-me",
    "staff_password": "changeme",
}


def check_deployment(settings: "Settings") -> list:
    """Reasons this configuration must not face the internet.

    Development defaults are convenient precisely because they are guessable:
    the signing key forges any session, and the staff account can read every
    clinic's cases. Refusing to start is the only reliable reminder.
    """
    if settings.environment.lower().startswith("dev"):
        return []

    problems = []
    for field, default in UNSAFE_DEFAULTS.items():
        if getattr(settings, field) == default:
            problems.append(f"{field.upper()} is still the development default")
    if not settings.cookie_secure:
        problems.append("COOKIE_SECURE is false, so the session cookie can travel in clear")
    if settings.database_url.startswith("sqlite") and "/tmp" in settings.database_url:
        problems.append("DATABASE_URL points at temporary storage")
    return problems
