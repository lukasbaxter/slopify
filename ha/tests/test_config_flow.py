"""Setting the integration up, signing in again, moving servers, options."""

from __future__ import annotations

from ipaddress import ip_address

from homeassistant import config_entries
from homeassistant.const import CONF_PASSWORD, CONF_URL, CONF_USERNAME, CONF_VERIFY_SSL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.helpers.service_info.zeroconf import ZeroconfServiceInfo
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.slopify.const import CONF_DEFAULT_SOURCE, CONF_TOKEN, DOMAIN

from .fake_slopify import SERVER_CLIENT, SERVER_ID, SPEAKER_KITCHEN, USER_ID, FakeSlopify


def _form(fake: FakeSlopify, **over: object) -> dict[str, object]:
    return {CONF_URL: fake.url, CONF_USERNAME: "lukas", CONF_PASSWORD: fake.password, CONF_VERIFY_SSL: True, **over}


async def test_sign_in_keeps_a_token_never_the_password(hass: HomeAssistant, fake: FakeSlopify) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM and result["step_id"] == "user"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], _form(fake, **{CONF_URL: fake.url + "/"})
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "lukas on 127.0.0.1"
    data = result["data"]
    assert CONF_PASSWORD not in data and fake.password not in str(data)
    assert data[CONF_URL] == fake.url
    assert data[CONF_TOKEN] in fake.tokens
    assert data["server_id"] == SERVER_ID
    assert result["result"].unique_id == USER_ID
    await hass.async_block_till_done()


async def test_errors_are_shown_on_the_form(hass: HomeAssistant, fake: FakeSlopify) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    flow = result["flow_id"]

    result = await hass.config_entries.flow.async_configure(flow, _form(fake, **{CONF_PASSWORD: "wrong"}))
    assert result["errors"] == {"base": "invalid_auth"}

    result = await hass.config_entries.flow.async_configure(flow, _form(fake, **{CONF_URL: "ftp://nope"}))
    assert result["errors"] == {CONF_URL: "invalid_url"}

    result = await hass.config_entries.flow.async_configure(flow, _form(fake, **{CONF_URL: "http://127.0.0.1:1"}))
    assert result["errors"] == {CONF_URL: "cannot_connect"}

    fake.health_ok = False
    result = await hass.config_entries.flow.async_configure(flow, _form(fake))
    assert result["errors"] == {CONF_URL: "not_slopify"}
    fake.health_ok = True

    fake.must_change = True
    before = set(fake.tokens)
    result = await hass.config_entries.flow.async_configure(flow, _form(fake))
    assert result["errors"] == {"base": "password_change_required"}
    assert set(fake.tokens) == before, "the unusable token is signed out again"
    fake.must_change = False

    result = await hass.config_entries.flow.async_configure(flow, _form(fake))
    assert result["type"] is FlowResultType.CREATE_ENTRY
    await hass.async_block_till_done()


async def test_the_same_account_twice_is_refused(
    hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify
) -> None:
    before = set(fake.tokens)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], _form(fake))
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "already_configured"
    assert set(fake.tokens) == before


def _zc(fake: FakeSlopify, server_id: str = SERVER_ID) -> ZeroconfServiceInfo:
    port = int(fake.url.rsplit(":", 1)[1])
    return ZeroconfServiceInfo(
        ip_address=ip_address("127.0.0.1"),
        ip_addresses=[ip_address("127.0.0.1")],
        port=port,
        hostname="slopify-55555555.local.",
        type="_slopify._tcp.local.",
        name="Slopify on box._slopify._tcp.local.",
        properties={"id": server_id, "name": "Slopify on box"},
    )


async def test_discovered_server_prefills_the_address(hass: HomeAssistant, fake: FakeSlopify) -> None:
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=_zc(fake)
    )
    assert result["type"] is FlowResultType.FORM and result["step_id"] == "user"
    schema = {
        str(k): k.default() for k in result["data_schema"].schema if hasattr(k, "default") and callable(k.default)
    }
    assert schema[CONF_URL] == fake.url
    flows = hass.config_entries.flow.async_progress()
    assert flows[0]["context"]["title_placeholders"] == {"name": "Slopify on box"}
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_URL: fake.url, CONF_USERNAME: "lukas", CONF_PASSWORD: fake.password}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["result"].unique_id == USER_ID
    await hass.async_block_till_done()


async def test_discovery_of_a_server_already_set_up_under_another_address(
    hass: HomeAssistant, fake: FakeSlopify
) -> None:
    MockConfigEntry(
        domain=DOMAIN,
        unique_id=USER_ID,
        data={CONF_URL: "https://music.example.com", "server_id": SERVER_ID, CONF_TOKEN: "x"},
    ).add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=_zc(fake)
    )
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "already_configured"


async def test_discovery_respects_ignore(hass: HomeAssistant, fake: FakeSlopify) -> None:
    MockConfigEntry(domain=DOMAIN, unique_id=f"server-{SERVER_ID}", source=config_entries.SOURCE_IGNORE).add_to_hass(
        hass
    )
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_ZEROCONF}, data=_zc(fake)
    )
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "already_configured"


async def test_reauth(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    result = await loaded.start_reauth_flow(hass)
    assert result["step_id"] == "reauth_confirm"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "lukas", CONF_PASSWORD: "wrong"}
    )
    assert result["errors"] == {"base": "invalid_auth"}
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "lukas", CONF_PASSWORD: fake.password}
    )
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "reauth_successful"
    assert loaded.data[CONF_TOKEN] != "tok-valid" and loaded.data[CONF_TOKEN] in fake.tokens
    await hass.async_block_till_done()


async def test_reauth_as_another_account_is_refused(hass: HomeAssistant, fake: FakeSlopify) -> None:
    other = MockConfigEntry(
        domain=DOMAIN,
        unique_id="someone-else",
        data={CONF_URL: fake.url, CONF_USERNAME: "lukas", CONF_TOKEN: "x", CONF_VERIFY_SSL: True},
    )
    other.add_to_hass(hass)
    before = set(fake.tokens)
    result = await other.start_reauth_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "lukas", CONF_PASSWORD: fake.password}
    )
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "wrong_account"
    assert set(fake.tokens) == before


async def test_reconfigure_moves_the_server(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    result = await loaded.start_reconfigure_flow(hass)
    assert result["step_id"] == "reconfigure"
    moved = f"{fake.url}/moved"
    result = await hass.config_entries.flow.async_configure(result["flow_id"], _form(fake, **{CONF_URL: moved}))
    assert result["type"] is FlowResultType.ABORT and result["reason"] == "reconfigure_successful"
    assert loaded.data[CONF_URL] == moved
    assert "tok-valid" in fake.logged_out, "the old sign-in is revoked"
    await hass.async_block_till_done()


async def test_options_offer_the_sources_found(hass: HomeAssistant, loaded: MockConfigEntry, fake: FakeSlopify) -> None:
    await fake.set_roster(lan=[{**SPEAKER_KITCHEN, "viaClient": SERVER_CLIENT}])
    await fake.wait_for(lambda: loaded.runtime_data.session.lan_devices)
    result = await hass.config_entries.options.async_init(loaded.entry_id)
    options = result["data_schema"].schema[CONF_DEFAULT_SOURCE].config["options"]
    assert [o["value"] for o in options] == ["last", "speaker:cast:kitchen"]
    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {CONF_DEFAULT_SOURCE: "speaker:cast:kitchen"}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert loaded.options[CONF_DEFAULT_SOURCE] == "speaker:cast:kitchen"
