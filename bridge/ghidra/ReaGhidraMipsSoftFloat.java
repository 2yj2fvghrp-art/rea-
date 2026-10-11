import ghidra.app.script.GhidraScript;
import ghidra.program.model.data.AbstractFloatDataType;
import ghidra.program.model.data.AbstractIntegerDataType;
import ghidra.program.model.data.DataType;
import ghidra.program.model.data.TypeDef;
import ghidra.program.model.data.Undefined;
import ghidra.program.model.lang.PrototypeModel;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Function.FunctionUpdateType;
import ghidra.program.model.listing.Parameter;
import ghidra.program.model.listing.ParameterImpl;
import ghidra.program.model.listing.Program;
import ghidra.program.model.listing.ReturnParameterImpl;
import ghidra.program.model.listing.VariableStorage;
import java.util.ArrayList;
import java.util.List;

/**
 * Soft-float o32 passes and returns float/double values in integer registers. Ghidra's MIPS32
 * compiler specifications model only hard-float o32, so a typed float signature (DWARF, type
 * archives) is otherwise bound to $f12/$f14/$f0 and the decompiler loses the real dataflow.
 * Keep each declared type, but commit the storage o32 assigns to an integer of the same size.
 */
public final class ReaGhidraMipsSoftFloat extends GhidraScript {
  static final String REPORT_KEY = "REA MIPS soft-float storage";
  static final String POLICY = "o32-integer-registers-v1";

  @Override
  public void run() throws Exception {
    String processor = currentProgram.getLanguage().getProcessor().toString();
    if (!processor.equals("MIPS") || currentProgram.getDefaultPointerSize() != 4)
      throw new IllegalStateException(
          "REA soft-float storage requires a 32-bit MIPS program, not " + processor);
    PrototypeModel model = currentProgram.getCompilerSpec().getDefaultCallingConvention();
    int remapped = 0;
    int retyped = 0;
    for (Function function : currentProgram.getFunctionManager().getFunctions(true)) {
      if (function.isThunk()) continue;
      Parameter[] parameters = function.getParameters();
      // Formal types: a struct returned through a hidden pointer stays a struct, so dynamic
      // storage keeps the $a0 auto-parameter instead of returning a bare pointer.
      DataType returned = function.getReturn().getFormalDataType();
      boolean floating = isFloat(returned);
      boolean auto = false;
      for (Parameter parameter : parameters) {
        floating |= isFloat(parameter.getFormalDataType());
        auto |= parameter.isAutoParameter();
      }
      if (!floating) continue;
      if (!auto && remap(function, model, returned, parameters)) {
        remapped += 1;
      }
      else {
        retype(function, returned, parameters);
        retyped += 1;
      }
    }
    // Written last: any failure above leaves no report, and REA refuses the session.
    currentProgram.getOptions(Program.PROGRAM_INFO).setString(
        REPORT_KEY,
        "{\"policy\":\"" + POLICY + "\",\"remapped\":" + remapped +
            ",\"retyped\":" + retyped + "}");
    println("REA MIPS soft-float storage: remapped=" + remapped + " retyped=" + retyped);
  }

  /**
   * Fallback when the declared shape cannot keep float types (auto-parameters such as a hidden
   * struct-return pointer, or unusual float sizes): drop float types for same-size integers and
   * let Ghidra recompute dynamic o32 storage, which is then the soft-float placement.
   */
  private void retype(Function function, DataType returned, Parameter[] parameters)
      throws Exception {
    List<ParameterImpl> updated = new ArrayList<>();
    for (Parameter parameter : parameters) {
      if (parameter.isAutoParameter()) continue;
      updated.add(new ParameterImpl(
          parameter.getName(),
          integerOrUndefined(parameter.getFormalDataType()),
          currentProgram,
          parameter.getSource()));
    }
    function.updateFunction(
        function.getCallingConventionName(),
        new ReturnParameterImpl(integerOrUndefined(returned), currentProgram),
        updated,
        FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS,
        true,
        function.getSignatureSource());
  }

  private DataType integerOrUndefined(DataType type) {
    DataType integer = integerFor(type);
    return integer != null ? integer : Undefined.getUndefinedDataType(resolve(type).getLength());
  }

  private boolean remap(
      Function function, PrototypeModel model, DataType returned, Parameter[] parameters)
      throws Exception {
    DataType[] types = new DataType[parameters.length + 1];
    types[0] = integerFor(returned);
    for (int index = 0; index < parameters.length; index += 1) {
      types[index + 1] = integerFor(parameters[index].getFormalDataType());
    }
    for (DataType type : types) {
      if (type == null) return false;
    }
    VariableStorage[] storage = model.getStorageLocations(currentProgram, types, false);
    if (storage.length != types.length) return false;
    for (VariableStorage item : storage) {
      if (item.isBadStorage() || item.isUnassignedStorage()) return false;
    }
    List<ParameterImpl> updated = new ArrayList<>();
    for (int index = 0; index < parameters.length; index += 1) {
      Parameter parameter = parameters[index];
      updated.add(new ParameterImpl(
          parameter.getName(),
          parameter.getFormalDataType(),
          storage[index + 1],
          currentProgram,
          parameter.getSource()));
    }
    function.updateFunction(
        function.getCallingConventionName(),
        new ReturnParameterImpl(returned, storage[0], true, currentProgram),
        updated,
        FunctionUpdateType.CUSTOM_STORAGE,
        true,
        function.getSignatureSource());
    return true;
  }

  /** Same-size integer for a float scalar; other types keep their own o32 placement. */
  private DataType integerFor(DataType type) {
    if (!isFloat(type)) return type;
    int size = resolve(type).getLength();
    if (size != 4 && size != 8) return null;
    return AbstractIntegerDataType.getUnsignedDataType(size, currentProgram.getDataTypeManager());
  }

  private static boolean isFloat(DataType type) {
    return resolve(type) instanceof AbstractFloatDataType;
  }

  private static DataType resolve(DataType type) {
    DataType current = type;
    while (current instanceof TypeDef typeDef) current = typeDef.getBaseDataType();
    return current;
  }
}
