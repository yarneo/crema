array set ::default_theme {
    background "#FFFFFF"
    background_highlight "#EEEEEE"
    background_text "#414A91"

    primary "#3D5682"
    primary_light "#417491"
    primary_dark "#414A91"

    secondary "#F27405"
    secondary_light "#F28705"

    button "#3D5682"
    button_coffee "#3D5682"
    button_steam "#417491"

    button_secondary "#F27405"
    button_tertiary "#182130"

    button_text_light "#eee"
    button_text_dark "#CCCCCC"
}
# Crema: espresso-black canvas, steamed-milk ink, curve colors from the
# de1 vernacular (pressure green / flow blue / weight amber). One accent:
# crema tan, spent only on the primary action and the grind number.
array set ::crema_theme {
    # Elevation, not outlines. The old ground (#1F1510) and card (#251A13) were
    # six RGB points apart, so borders did all the separating - which is exactly
    # what reads as dated. Three real steps: ground -> card -> control.
    background "#14100D"
    background_highlight "#1E1815"
    background_text "#F3E8DF"

    primary "#3ECF97"
    primary_light "#2A7A58"
    primary_dark "#52D6A4"

    secondary "#5AAEF0"
    secondary_light "#2F6386"

    button "#282019"
    button_coffee "#282019"
    button_steam "#282019"

    button_secondary "#F2A65A"
    button_tertiary "#282019"

    button_text_light "#F3E8DF"
    button_text_dark "#C6B3A0"

    accent "#F2A65A"
    accent_text "#2B1A0C"
    muted "#A28E7C"
    dim "#6E5B4A"
    ghost "#4A3C30"
    weight "#E2A13F"
    success "#57A85A"
    card_outline "#2E251E"
    card_fill "#1E1815"
    grid_line "#241D17"
}

# Crema light: warm paper, same accent family, curve colors deepened for
# contrast on light ground
array set ::crema_light_theme {
    # The default. Same elevation logic as the dark theme, inverted: a warm
    # off-white ground with cards lifting to near-white, and a hairline only
    # where a white-on-cream edge would otherwise be invisible.
    background "#F4EFE7"
    background_highlight "#FFFCF7"
    background_text "#241A13"

    primary "#12805A"
    primary_light "#8FC9B0"
    primary_dark "#0E6B4B"

    secondary "#1E6FA8"
    secondary_light "#9BC2DE"

    button "#EBE4D9"
    button_coffee "#EBE4D9"
    button_steam "#EBE4D9"

    button_secondary "#C4702A"
    button_tertiary "#EBE4D9"

    button_text_light "#241A13"
    button_text_dark "#5E4E41"

    accent "#C4702A"
    accent_text "#FFFCF7"
    muted "#7A6857"
    dim "#B5A692"
    ghost "#DCD2C2"
    weight "#A96A12"
    success "#1E7A47"
    card_outline "#E6DDCE"
    card_fill "#FFFCF7"
    grid_line "#EDE5D8"
}

# By Brian K
array set ::dark_theme {
    background "#121212"
    background_highlight "#121212"
    background_text "#FFFFFF"

    primary "#BB86FC"
    primary_light "#BB86FC"
    primary_dark "#BB86FC"

    secondary "#03DAC6"
    secondary_light "#03DAC6"

    button "#1E1E1E"
    button_coffee "#1E1E1E"
    button_steam "#1E1E1E"
    button_secondary "#1E1E1E"
    button_tertiary "#1E1E1E"

    button_text_light "#FFFFFF"
    button_text_dark "#969eb1"
}

array set ::purple_theme {
    background "#3c3c48"
    background_highlight "#343444"
    background_text "#FFFFFF"

    primary "#b73f49"
    primary_light "#c74f59"
    primary_dark "#a72f39"

    secondary "#e2a3b6"
    secondary_light "#bf8a9a"

    button "#b73f49"
    button_coffee "#b73f49"
    button_steam "#c74f59"
    button_secondary "#3d3b5e"
    button_tertiary "#7a354b"

    button_text_light "#eee"
    button_text_dark "#CCCCCC"
}

array set ::red_theme {
    background "#FFFFFF"
    background_highlight "#f5f3f4"
    background_text "#a4161a"

    primary "#ba181b"
    primary_light "#e5383b"
    primary_dark "#a4161a"

    secondary "#0b090a"
    secondary_light "#161a1d"

    button "#ba181b"
    button_coffee "#ba181b"
    button_steam "#e5383b"
    button_secondary "#ba181b"
    button_tertiary "#ba181b"

    button_text_light "#eee"
    button_text_dark "#CCCCCC"
}

# By Ryan Schubert
array set ::cocoa_theme {
    background "#1e1e1e"
    background_highlight "#1e1e1e"
    background_text "#FFFFFF"

    primary "#18c37e"
    primary_light "#18c37e"
    primary_dark "#18c37e"

    secondary "#4e85f4"
    secondary_light "#4e85f4"

    button "#363636"
    button_coffee "#3d322d"
    button_steam "#363636"
    button_secondary "#363636"
    button_tertiary "#363636"

    button_text_light "#FFFFFF"
    button_text_dark "#969eb1"
}

array set ::rainforest_theme {
    background "#FFFFFF"
    background_highlight "#EEEEEE"
    background_text "#414A91"

    primary "#2a9d8f"
    primary_light "#2a9d8f"
    primary_dark "#264653"

    secondary "#e9c46a"
    secondary_light "#f4a261"

    button "#28535c"
    button_coffee "#28535c"
    button_steam "#28535c"
    button_secondary "#758b81"
    button_tertiary "#28535c"

    button_text_light "#FFFFFF"
    button_text_dark "#969eb1"

    background_image "coffee_beans.jpg"
}

# fonts
set ::font_tiniest [get_font "Mazzard Regular" 13]
set ::font_tinier [get_font "Mazzard Regular" 15]
set ::font_tiny [get_font "Mazzard Regular" 16]
set ::font_small [get_font "Mazzard Regular" 18]
set ::font_big [get_font "Mazzard Regular" 22]
set ::font_tiny_icon [get_font "Font Awesome 5 Free-Solid-900" 16]
set ::font_small_icon [get_font "Font Awesome 5 Free-Solid-900" 18]
set ::font_big_icon [get_font "Font Awesome 5 Free-Solid-900" 22]

set ::font_tiny_header [get_font "Mazzard SemiBold" 16]
set ::font_small_header [get_font "Mazzard SemiBold" 18]

array set ::iconik_settings {
    profiles {1 {name default title Default} 2 {name {Gentle and sweet} title {Gentle and sweet}} 3 {name rao_allonge title {Rao Allongé}} 4 {name {Classic Italian espresso} title {Classic Italian espresso}} 5 {name {Blooming espresso} title {Blooming Espresso}}}
    steam_profiles {1 {timeout {26}} 2 {timeout {30}}}

    flush_timeout 3
    steam_active_slot 0

    reset_to_main_profile 0
    main_profile_slot 1

    theme "::default_theme"

    cleanup_use_profile 0
    cleanup_profile "weber_spring_clean"
    cleanup_bypass_shot_history 0
    cleanup_restore_selected_profile 0
    tmp_profile_to_restore_after_cleanup {}

    show_steam 0
    steam_presets_enabled 1
    show_grinder_settings_on_main_page 0
    show_clock_on_main_page 0
    small_mug_setting 0
    large_mug_setting 0
    always_show_temperatures 0
    create_profile_backups 0
    show_grid_lines 1
    show_steam_grid_lines 1
    show_resistance 1

    saver_dir {/saver}

    show_water_level_indicator 0
    show_ml_instead_of_water_level 1
    water_temperature_overwride 95
    seperate_flow_axis 0

    y_axis_scale 12
    max_history_items 100

    ui "default"
}

proc ::theme {cntx} {
    set theme_name $::iconik_settings(theme)
    return [ifexists ${theme_name}($cntx)]
}


proc iconik_settings_filename {} {
    return "[skin_directory]/settings.tdb"
}

proc iconik_array_to_file {arrname fn} {
    upvar $arrname item
    set icnoik_data {}
    foreach k [lsort -dictionary [array names item]] {
        set v $item($k)
        append icnoik_data [subst {[list $k] [list $v]\n}]
    }
    write_file $fn $icnoik_data
}

proc iconik_save_settings {} {

    set ::settings(flush_seconds) [round_to_integer [expr $::iconik_settings(flush_timeout) + 1]]
    set_flush_timeout $::settings(flush_seconds)

    iconik_array_to_file ::iconik_settings [iconik_settings_filename]
}

proc iconik_load_settings {} {
    array set ::iconik_settings [encoding convertfrom utf-8 [read_binary_file [iconik_settings_filename]]]
}
