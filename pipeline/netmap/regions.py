"""Country -> RIR-style region, and the Opte-inspired palette.

The classic Opte maps colour nodes by registry region:
Asia Pacific red, Europe/Middle East green, North America blue,
Latin America yellow, Africa orange, unknown white.
"""

REGIONS = ["unknown", "na", "eu", "ap", "lac", "af"]
REGION_NAMES = {
    "unknown": "Unknown",
    "na": "North America",
    "eu": "Europe / Middle East / Central Asia",
    "ap": "Asia Pacific",
    "lac": "Latin America & Caribbean",
    "af": "Africa",
}
# RGB, tuned for additive blending on black.
PALETTE = {
    "unknown": (220, 220, 220),
    "na": (70, 110, 255),
    "eu": (60, 210, 90),
    "ap": (255, 70, 60),
    "lac": (245, 215, 50),
    "af": (255, 140, 30),
}

_BY_REGION = {
    "na": "US CA BM PM UM GL",
    "lac": (
        "MX GT BZ SV HN NI CR PA CU JM HT DO PR BS BB TT AG DM GD KN LC VC "
        "AW CW SX BQ KY TC VG VI AI MS GP MQ BL MF CO VE EC PE BO BR PY UY "
        "AR CL GY SR GF FK"
    ),
    "eu": (
        "GB IE FR DE NL BE LU CH AT IT ES PT AD MC SM VA MT DK NO SE FI IS "
        "FO AX EE LV LT PL CZ SK HU SI HR BA RS ME MK AL GR BG RO MD UA BY RU "
        "TR CY GE AM AZ KZ KG TJ TM UZ IL PS JO LB SY IQ IR SA AE QA BH KW OM "
        "YE GI GG JE IM LI XK SJ EU"
    ),
    "ap": (
        "CN HK MO TW JP KR KP MN IN PK BD LK NP BT MV AF SG MY ID TH VN LA KH "
        "MM PH BN TL AU NZ PG FJ SB VU NC PF WS TO KI TV NR FM MH PW GU MP AS "
        "CK NU TK WF IO CX CC NF HM AP"
    ),
    "af": (
        "EG LY TN DZ MA EH SD SS ET ER DJ SO KE UG TZ RW BI CD CG GA GQ CM CF "
        "TD NE NG BJ TG GH CI LR SL GN GW SN GM ML BF MR CV ST AO ZM ZW MW MZ "
        "MG MU SC KM RE YT NA BW ZA LS SZ SH"
    ),
}

COUNTRY_REGION = {cc: r for r, ccs in _BY_REGION.items() for cc in ccs.split()}


def region_of(cc: str | None) -> str:
    if not cc:
        return "unknown"
    return COUNTRY_REGION.get(cc.upper(), "unknown")
