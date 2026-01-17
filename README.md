# DAB WebUI (Node) - V0.1

Objectif : reprendre l'esprit de DabCast (Gambas) mais en **WebApp Node** facile à installer.

## Démarrage rapide

```bash
cd server
npm install
npm start
```

Puis ouvrir : `http://<IP>:8080`

## Démo incluse

Un preset **DemoMux** avec 4 radios (MAXXIMA, FIP, CLASSIC21, RVM) est préchargé.
Les dossiers MOT (DLS/SLS) sont dans `data/mot/*`.

## Notes importantes

- Les commandes `odr-dabmux`, `odr-audioenc`, `odr-padenc` doivent être installées sur la machine.
- Si les binaires ne sont pas dans le PATH, édite `data/settings.json` et renseigne `odrBinDir`.
- Pendant `ON AIR`, certains champs (bitrate, PS8/PS16, etc.) sont volontairement verrouillés (comme DabCast).

