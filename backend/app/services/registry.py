"""Dental council registry check.

Ported from the old ``fire.py``. The LLM name-matcher it used has been dropped —
it was a language model asked to answer "do these two names match", which
rapidfuzz already does deterministically and for free.

The result is advisory. Staff always make the final verification call, so a
registry timeout never blocks a signup.
"""

from __future__ import annotations

import logging

from ..config import settings

log = logging.getLogger(__name__)

DCI_URL = "https://dciindia.gov.in/DentistDetails.aspx"
MATCH_THRESHOLD = 58

DENTAL_COUNCILS: dict[str, str] = {
    "AND": "Andhra Pradesh State Dental Council",
    "ARN": "Arunachal Pradesh State Dental Council",
    "ASS": "Assam State Dental Council",
    "BIH": "Bihar State Dental Council",
    "CHA": "Chhattisgarh State Dental Council",
    "CHG": "Dental Council of Chandigarh",
    "DEL": "Delhi State Dental Council",
    "GOA": "Goa State Dental Council",
    "GUJ": "Gujarat State Dental Council",
    "HAR": "Haryana State Dental Council",
    "HP": "Himachal Pradesh State Dental Council",
    "JHA": "Jharkhand State Dental Council",
    "JK": "J & K State Dental Council",
    "KAR": "Karnataka State Dental Council",
    "KER": "Kerala State Dental Council",
    "MAD": "Madhya Pradesh State Dental Council",
    "MAH": "Maharashtra State Dental Council",
    "MEG": "Meghalaya State Dental Council",
    "MIZ": "Mizoram State Registration Tribunal",
    "MS": "Manipur State Dental Council",
    "NS": "Nagaland State Dental Council",
    "ORI": "Orissa State Dental Council",
    "PON": "State Dental Council, Puducherry",
    "PUN": "Punjab State Dental Council",
    "RAJ": "Rajasthan State Dental Council",
    "SKM": "Sikkim Dental Registration Tribunal",
    "TAM": "Tamil Nadu State Dental Council",
    "TRI": "Tripura State Dental Council",
    "TS": "Telangana Dental Council",
    "UP": "Uttar Pradesh State Dental Council",
    "UTR": "Uttarakhand Dentists Registration Tribunals",
    "WES": "West Bengal State Dental Council",
}

COUNCIL_CODES = {name: code for code, name in DENTAL_COUNCILS.items()}


def name_match_score(input_name: str, candidates: list[str]) -> int:
    from rapidfuzz import fuzz

    if not candidates:
        return 0
    lowered = input_name.lower()
    return int(max(fuzz.token_sort_ratio(lowered, c.lower()) for c in candidates))


def check_registration(full_name: str, registration_number: str, council_name: str) -> dict:
    """Returns a result dict that is stored verbatim on the doctor record and
    shown to staff beside what the doctor typed."""
    if not settings.dci_check_enabled:
        return {"checked": False, "reason": "Registry check disabled."}

    state_code = COUNCIL_CODES.get(council_name, "0")
    try:
        import requests
        from bs4 import BeautifulSoup

        session = requests.Session()
        page = session.get(DCI_URL, timeout=30)
        soup = BeautifulSoup(page.text, "html.parser")

        def hidden(field_id: str) -> str:
            tag = soup.find("input", {"id": field_id})
            return tag["value"] if tag and tag.has_attr("value") else ""

        payload = {
            "__EVENTTARGET": "",
            "__EVENTARGUMENT": "",
            "__VIEWSTATE": hidden("__VIEWSTATE"),
            "__VIEWSTATEGENERATOR": hidden("__VIEWSTATEGENERATOR"),
            "__EVENTVALIDATION": hidden("__EVENTVALIDATION"),
            "ctl00$MainContent$txtName": "",
            "ctl00$MainContent$txtRegNo": registration_number,
            "ctl00$MainContent$ddlSDC": state_code or "0",
            "ctl00$MainContent$btnSearch": "Search",
        }
        result = session.post(
            DCI_URL,
            data=payload,
            headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded"},
            timeout=45,
        )
        table = BeautifulSoup(result.text, "html.parser").find("table", {"id": "MainContent_GVSmall"})

        matches: list[str] = []
        if table:
            for row in table.find_all("tr")[1:]:
                cols = [td.get_text(strip=True) for td in row.find_all("td")]
                if len(cols) == 4 and cols[2] == registration_number:
                    matches.append(cols[1])

        score = name_match_score(full_name, matches)
        return {
            "checked": True,
            "registry_names": matches,
            "name_match_score": score,
            "passed": score > MATCH_THRESHOLD,
        }
    except Exception as exc:  # noqa: BLE001 — advisory only, must never block signup
        log.warning("Registry check failed for %s: %s", registration_number, exc)
        return {"checked": False, "reason": f"Registry unreachable: {exc}"}
