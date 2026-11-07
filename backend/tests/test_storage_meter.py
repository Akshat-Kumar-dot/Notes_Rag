from app.api.files import _meter_limit
from app.config import settings

MB = 1024 * 1024


def test_guest_meter_shows_the_trial_upload_limit():
    assert _meter_limit(is_guest=True) == settings.guest_max_upload_mb * MB


def test_signed_in_meter_shows_the_account_quota():
    assert _meter_limit(is_guest=False) == settings.storage_limit_mb * MB
