import ghidra.app.script.GhidraScript;
import ghidra.framework.options.Options;
import ghidra.framework.options.OptionType;
import ghidra.program.model.listing.Program;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Disable the named auto-analyzers before default auto-analysis.
 *
 * <p>Fails closed. Ghidra's {@code GhidraScript.setAnalysisOption} only logs an
 * error for a name the program does not recognize and silently skips a value it
 * cannot apply, so a typo would let the real analyzer run while the analysis
 * profile still records it as disabled. This script validates every requested
 * name against the program's registered analyzer options, reads each option
 * back as disabled, and aborts (by throwing) before auto-analysis and bridge
 * startup when any name is unknown or cannot be applied.
 */
public final class ReaGhidraAnalysisOptions extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] arguments = getScriptArgs();
        if (arguments.length != 1 || arguments[0].isBlank()) {
            throw new IllegalArgumentException(
                "ReaGhidraAnalysisOptions requires one comma-separated analyzer-name argument");
        }
        Set<String> names = new LinkedHashSet<>();
        for (String raw : arguments[0].split(",")) {
            String name = raw.trim();
            if (!name.isEmpty()) {
                names.add(name);
            }
        }
        Options analysisOptions = currentProgram.getOptions(Program.ANALYSIS_PROPERTIES);
        List<String> unknown = new ArrayList<>();
        List<String> unapplied = new ArrayList<>();
        for (String name : names) {
            monitor.checkCancelled();
            // A registered analyzer's enable flag is a boolean option stored
            // under the analyzer's exact name; anything else is not a name
            // this script can disable.
            if (!analysisOptions.contains(name)
                || analysisOptions.getType(name) != OptionType.BOOLEAN_TYPE) {
                unknown.add(name);
                continue;
            }
            setAnalysisOption(currentProgram, name, "false");
            if (analysisOptions.getBoolean(name, true)) {
                unapplied.add(name);
            }
        }
        if (!unknown.isEmpty() || !unapplied.isEmpty()) {
            throw new IllegalArgumentException(
                "ReaGhidraAnalysisOptions refused to continue with analyzers that are"
                    + " unknown or still enabled; use exact registered analyzer names."
                    + (unknown.isEmpty() ? "" : " unknown=" + unknown)
                    + (unapplied.isEmpty() ? "" : " notApplied=" + unapplied));
        }
    }
}
